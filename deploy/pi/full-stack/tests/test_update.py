"""Exercise deployment state transitions without Docker, SSH, or network access."""

from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


DIRECTORY = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pi_update", DIRECTORY / "update.py")
update = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(DIRECTORY), *sys.path]):
    SPEC.loader.exec_module(update)


def image(component, letter):
    return f"mikedim95/garsone-{component}@sha256:" + letter * 64


OLD_CORE = image("core", "a")
NEW_CORE = image("core", "b")
OLD_FRONT = image("front", "c")
NEW_FRONT = image("front", "d")
DATABASE_IMAGE = "postgres@sha256:" + "e" * 64
INITIAL_LOCK = (
    "# Keep the database and unrelated component pinned.\n"
    f"CORE_IMAGE={OLD_CORE}\nFRONT_IMAGE={OLD_FRONT}\nPOSTGRES_IMAGE={DATABASE_IMAGE}\n"
)


def publication(component):
    sha = "1" * 40 if component == "core" else "2" * 40
    return {
        "component": component,
        "imageTag": f"mikedim95/garsone-{component}:stable-{sha}",
        "sourceSha": sha,
        "workflowRunId": 123,
        "workflowUrl": "https://github.com/mikedim95/Garsone-Core/actions/runs/123",
        "repository": "mikedim95/Garsone-Core" if component == "core" else "mikedim95/Garsone-Front",
        "channel": "stable",
    }


class FakePi:
    """Small runtime model: pins, containers, ingress, cached upstream and data."""

    def __init__(self, directory):
        self.directory = directory
        self.env = {"FRONT_PORT": "8080"}
        self.events = []
        self.containers = {
            service: {
                "Id": service + "-original",
                "Image": reference,
                "Config": {"Image": reference},
                "State": {"Running": True, "Health": {"Status": "healthy"}},
                "Mounts": [],
            }
            for service, reference in {"db": DATABASE_IMAGE, "core": OLD_CORE, "front": OLD_FRONT}.items()
        }
        self.front_upstream = self.containers["core"]["Id"]
        self.resolved_images = {"core": NEW_CORE, "front": NEW_FRONT}
        self.database_orders = ["customer-order-before-deploy"]
        self.activation_count = 0
        self.backup_failure = False
        self.fail_new_front_once = False
        self.fail_new_core_once = False
        self.pull_failure = False

    def pins(self):
        return update.read_env(self.directory / "images.lock.env")

    def compose(self, *args, **kwargs):
        self.events.append(("compose", args))
        if args[0] == "config":
            assert self.pins()["POSTGRES_IMAGE"] == DATABASE_IMAGE
        elif args[0] == "stop":
            for service in args[3:]:
                self.containers[service]["State"]["Running"] = False
        else:
            raise AssertionError(f"Unexpected Compose operation: {args}")

    def container(self, service):
        return deepcopy(self.containers[service])

    def healthy(self):
        self.events.append(("healthy",))
        for service, container in self.containers.items():
            if not container["State"]["Running"]:
                raise RuntimeError(f"{service} is stopped")
        if self.front_upstream != self.containers["core"]["Id"]:
            raise RuntimeError("Frontend still resolves the previous Core container")
        if self.fail_new_front_once and self.containers["front"]["Config"]["Image"] == NEW_FRONT:
            self.fail_new_front_once = False
            self.database_orders.append("customer-order-during-deploy")
            raise RuntimeError("New frontend failed its public API health check")
        if self.fail_new_core_once and self.containers["core"]["Config"]["Image"] == NEW_CORE:
            self.fail_new_core_once = False
            self.database_orders.append("customer-order-during-deploy")
            raise RuntimeError("New Core failed health verification")

    def pull(self, release):
        self.events.append(("pull", release["component"]))
        if self.pull_failure:
            raise RuntimeError("Docker Hub unavailable")
        return self.resolved_images[release["component"]]

    def backup_data(self, directory, old_core):
        self.events.append(("backup", self.pins()))
        assert not self.containers["core"]["State"]["Running"], "Core must stop before backup"
        assert not self.containers["front"]["State"]["Running"], "Customer ingress must stop before backup"
        assert self.containers["db"]["State"]["Running"], "Postgres must remain available for pg_dump"
        assert self.pins()["CORE_IMAGE"] == OLD_CORE, "Do not activate new pins before validating backup"
        assert old_core["Id"] == "core-original"
        if self.backup_failure:
            raise RuntimeError("Database backup failed validation")
        (directory / "database.dump").write_bytes(b"validated-dump")
        (directory / "uploads.tar.gz").write_bytes(b"uploads-archive")
        (directory / "print-spool.tar.gz").write_bytes(b"spool-archive")

    def start(self, *services, recreate=False):
        self.events.append(("start", services, recreate, self.pins()))
        for service in services:
            if service == "db":
                raise AssertionError("An app update must not restart Postgres")
            reference = self.pins()[update.IMAGE_KEYS[service]]
            current = self.containers[service]
            if reference != current["Config"]["Image"] or recreate:
                self.activation_count += 1
                current["Id"] = f"{service}-activation-{self.activation_count}"
                current["Config"]["Image"] = reference
                current["Image"] = reference
            current["State"]["Running"] = True
            if service == "front":
                self.front_upstream = self.containers["core"]["Id"]


class UpdateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        (self.directory / "images.lock.env").write_text(INITIAL_LOCK, encoding="utf-8")
        (self.directory / ".env").write_text("IMAGE_MODE=published\nLOCAL_ADMIN_PASSWORD=test-only\n", encoding="utf-8")
        (self.directory / "compose.yml").write_text("services: {}\n", encoding="utf-8")
        self.pi = FakePi(self.directory)
        self.output = self.enterContext(patch("sys.stdout", new_callable=io.StringIO))
        self.errors = self.enterContext(patch("sys.stderr", new_callable=io.StringIO))

    def record(self):
        records = list((self.directory / "backups").glob("update-*/release.json"))
        self.assertEqual(len(records), 1)
        return json.loads(records[0].read_text())

    def starts(self):
        return [event for event in self.pi.events if event[0] == "start"]

    def assert_original_pins_and_running_apps(self):
        self.assertEqual((self.directory / "images.lock.env").read_text(), INITIAL_LOCK)
        self.assertEqual(self.pi.container("core")["Config"]["Image"], OLD_CORE)
        self.assertEqual(self.pi.container("front")["Config"]["Image"], OLD_FRONT)
        self.assertTrue(all(value["State"]["Running"] for value in self.pi.containers.values()))
        self.assertEqual(self.pi.container("db")["Id"], "db-original")

    def test_no_op_keeps_all_containers_running_without_backup_or_restart(self):
        self.pi.resolved_images = {"core": OLD_CORE, "front": OLD_FRONT}
        update.apply(self.pi, [publication("core"), publication("front")])
        self.assertEqual(self.starts(), [])
        self.assertFalse(any(event[0] == "backup" for event in self.pi.events))
        self.assertFalse((self.directory / "backups").exists())
        self.assert_original_pins_and_running_apps()
        self.assertIn("Nothing restarted", self.output.getvalue())

    def test_front_update_keeps_core_database_and_unrelated_pins(self):
        update.apply(self.pi, [publication("front")])
        self.assertEqual(self.pi.container("front")["Config"]["Image"], NEW_FRONT)
        self.assertEqual(self.pi.container("core")["Id"], "core-original")
        self.assertEqual(self.pi.container("db")["Id"], "db-original")
        self.assertEqual(self.pi.pins()["CORE_IMAGE"], OLD_CORE)
        self.assertEqual(self.pi.pins()["POSTGRES_IMAGE"], DATABASE_IMAGE)
        self.assertEqual([event[1] for event in self.starts()], [("front",)])
        self.assertFalse(any(event[0] == "backup" for event in self.pi.events))
        self.assertFalse(any(event[0] == "compose" and event[1][0] == "stop" for event in self.pi.events))
        record = self.record()
        self.assertEqual(record["status"], "healthy")
        self.assertEqual(record["previousImages"]["FRONT_IMAGE"], OLD_FRONT)
        self.assertEqual(json.loads((self.directory / ".deployed-release.json").read_text()), record)

    def test_front_health_failure_restores_previous_pins_without_rewinding_orders(self):
        self.pi.fail_new_front_once = True
        with self.assertRaisesRegex(RuntimeError, "New frontend failed"):
            update.apply(self.pi, [publication("front")])
        self.assert_original_pins_and_running_apps()
        self.assertEqual(self.pi.container("core")["Id"], "core-original")
        self.assertEqual([event[1] for event in self.starts()], [("front",), ("front",)])
        self.assertIn("customer-order-during-deploy", self.pi.database_orders)
        record = self.record()
        self.assertEqual(record["status"], "failed")
        self.assertFalse(record["databaseRestored"])
        self.assertIn("Previous app image pins restored", record["recovery"])
        self.assertFalse((self.directory / ".deployed-release.json").exists())

    def test_core_stops_writers_and_validates_backup_before_activating_pins(self):
        update.apply(self.pi, [publication("core")])
        stop_index = self.pi.events.index(("compose", ("stop", "--timeout", "30", "front", "core")))
        backup_index = next(index for index, event in enumerate(self.pi.events) if event[0] == "backup")
        start_index = next(index for index, event in enumerate(self.pi.events) if event[0] == "start")
        self.assertLess(stop_index, backup_index)
        self.assertLess(backup_index, start_index)
        self.assertEqual(self.pi.events[backup_index][1]["CORE_IMAGE"], OLD_CORE)
        self.assertEqual(self.pi.events[start_index][3]["CORE_IMAGE"], NEW_CORE)
        record = self.record()
        backup = Path(record["backupDirectory"])
        self.assertEqual((backup / "images.lock.env").read_text(), INITIAL_LOCK)
        for name in ("database.dump", "uploads.tar.gz", "print-spool.tar.gz"):
            self.assertGreater((backup / name).stat().st_size, 0)
        self.assertEqual(self.pi.container("db")["Id"], "db-original")

    def test_front_is_recreated_after_core_replacement_to_refresh_nginx_upstream(self):
        update.apply(self.pi, [publication("core")])
        starts = self.starts()
        self.assertEqual([(event[1], event[2]) for event in starts], [(("core",), False), (("front",), True)])
        self.assertEqual(self.pi.pins()["FRONT_IMAGE"], OLD_FRONT)
        self.assertNotEqual(self.pi.container("front")["Id"], "front-original")
        self.assertEqual(self.pi.front_upstream, self.pi.container("core")["Id"])

    def test_failed_backup_restarts_previous_apps_without_activating_new_core(self):
        self.pi.backup_failure = True
        with self.assertRaisesRegex(RuntimeError, "backup failed validation"):
            update.apply(self.pi, [publication("core"), publication("front")])
        self.assert_original_pins_and_running_apps()
        for event in self.starts():
            self.assertEqual(event[3]["CORE_IMAGE"], OLD_CORE)
            self.assertEqual(event[3]["FRONT_IMAGE"], OLD_FRONT)
        self.assertEqual(self.pi.container("core")["Id"], "core-original")
        self.assertEqual(self.record()["status"], "failed")
        self.assertIn("Previous app image pins restored", self.record()["recovery"])

    def test_core_health_failure_restores_app_pins_and_recreates_front_again(self):
        self.pi.fail_new_core_once = True
        with self.assertRaisesRegex(RuntimeError, "New Core failed"):
            update.apply(self.pi, [publication("core"), publication("front")])
        self.assert_original_pins_and_running_apps()
        self.assertEqual(
            [(event[1], event[2]) for event in self.starts()],
            [(("core",), False), (("front",), True), (("core",), False), (("front",), True)],
        )
        self.assertIn("customer-order-during-deploy", self.pi.database_orders)
        self.assertFalse(self.record()["databaseRestored"])

    def test_failed_new_lock_write_restarts_previous_apps_without_retrying_failed_write(self):
        write = update.atomic_write
        lock_writes = []

        def full_disk_for_lock(path, content):
            if path == self.directory / "images.lock.env":
                lock_writes.append(content)
                raise OSError("No space left for new release lock")
            write(path, content)

        with patch.object(update, "atomic_write", side_effect=full_disk_for_lock):
            with self.assertRaisesRegex(OSError, "No space left"):
                update.apply(self.pi, [publication("core")])
        self.assertEqual(len(lock_writes), 1)
        self.assert_original_pins_and_running_apps()
        self.assertEqual(self.record()["status"], "failed")
        self.assertIn("Previous app image pins restored", self.record()["recovery"])

    def test_interrupt_during_core_activation_recovers_before_propagating_interrupt(self):
        start = self.pi.start

        def interrupt_new_core(*services, **kwargs):
            start(*services, **kwargs)
            if services == ("core",) and self.pi.pins()["CORE_IMAGE"] == NEW_CORE:
                raise KeyboardInterrupt()

        with patch.object(self.pi, "start", side_effect=interrupt_new_core):
            with self.assertRaises(KeyboardInterrupt):
                update.apply(self.pi, [publication("core")])
        self.assert_original_pins_and_running_apps()
        self.assertEqual(self.pi.front_upstream, self.pi.container("core")["Id"])
        self.assertEqual(self.record()["status"], "failed")

    def test_healthy_container_on_wrong_image_is_rejected_and_pins_restored(self):
        start = self.pi.start

        def ignore_new_front(*services, **kwargs):
            if self.pi.pins()["FRONT_IMAGE"] == NEW_FRONT:
                return
            start(*services, **kwargs)

        with patch.object(self.pi, "start", side_effect=ignore_new_front):
            with self.assertRaisesRegex(RuntimeError, "did not activate the selected image"):
                update.apply(self.pi, [publication("front")])
        self.assert_original_pins_and_running_apps()
        self.assertEqual(self.record()["status"], "failed")

    def test_pull_failure_does_not_stop_apps_or_change_pins(self):
        self.pi.pull_failure = True
        with self.assertRaisesRegex(RuntimeError, "Docker Hub unavailable"):
            update.apply(self.pi, [publication("core")])
        self.assert_original_pins_and_running_apps()
        self.assertEqual(self.starts(), [])
        self.assertFalse((self.directory / "backups").exists())


class PiExecutionTests(unittest.TestCase):
    def test_start_never_builds_pulls_or_recreates_dependencies(self):
        pi = object.__new__(update.Pi)
        with patch.object(pi, "compose") as execute:
            pi.start("front", recreate=True)
        args = execute.call_args.args
        self.assertIn("--no-deps", args)
        self.assertIn("--no-build", args)
        self.assertEqual(args[args.index("--pull") + 1], "never")
        self.assertIn("--wait", args)
        self.assertIn("--force-recreate", args)
        self.assertEqual(args[-1], "front")

    def test_pull_refuses_wrong_architecture_or_ambiguous_registry_digest(self):
        pi = object.__new__(update.Pi)
        for detail in [
            {"Os": "linux", "Architecture": "amd64", "RepoDigests": [NEW_FRONT]},
            {"Os": "windows", "Architecture": "arm64", "RepoDigests": [NEW_FRONT]},
            {"Os": "linux", "Architecture": "arm64", "RepoDigests": []},
            {"Os": "linux", "Architecture": "arm64", "RepoDigests": [OLD_FRONT, NEW_FRONT]},
            {"Os": "linux", "Architecture": "arm64", "RepoDigests": [NEW_CORE]},
        ]:
            with self.subTest(detail=detail), patch.object(pi, "run", side_effect=[
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0, stdout=json.dumps([detail])),
            ]):
                with self.assertRaises(RuntimeError):
                    pi.pull(publication("front"))

    def test_pull_returns_verified_digest_after_platform_specific_pull(self):
        pi = object.__new__(update.Pi)
        detail = {"Os": "linux", "Architecture": "arm64", "RepoDigests": [NEW_FRONT]}
        with patch.object(pi, "run", side_effect=[
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout=json.dumps([detail])),
        ]) as execute:
            self.assertEqual(pi.pull(publication("front")), NEW_FRONT)
        self.assertEqual(execute.call_args_list[0].args[0], [
            "docker", "pull", "--platform", "linux/arm64", publication("front")["imageTag"],
        ])


if __name__ == "__main__":
    unittest.main()
