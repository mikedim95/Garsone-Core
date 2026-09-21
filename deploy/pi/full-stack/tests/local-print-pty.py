"""Linux-only serial simulation. Run in Core's Docker build stage (Python+Node)."""
import json
import os
import pathlib
import pty
import select
import subprocess
import tempfile
import time

master, slave = pty.openpty()
device = os.ttyname(slave)
core_root = pathlib.Path(os.environ["CORE_TEST_DIR"]) if os.environ.get("CORE_TEST_DIR") else pathlib.Path(__file__).resolve().parents[4]
with tempfile.TemporaryDirectory() as temp:
    routes = pathlib.Path(temp) / "printers.json"
    routes.write_text(json.dumps({"noor/orders/placed/printer_1": {"device": device, "encoding": "cp1253"}}))
    env = dict(os.environ, LOCAL_PRINTING_ENABLED="true", LOCAL_PRINTER_ROUTES_FILE=str(routes), LOCAL_PRINT_SPOOL=temp + "/spool")
    script = """
import assert from 'node:assert/strict';
import {startLocalPrinting, enqueueLocalPrint, usesLocalPrinter, localPrintStatus, renderLocalTicket} from '/app/dist/lib/localPrinting.js';
import iconv from '/app/node_modules/iconv-lite/lib/index.js';
await startLocalPrinting();
assert.equal(usesLocalPrinter('noor/orders/ready/printer_1'), false);
assert.equal(usesLocalPrinter('other/orders/placed/printer_1'), false);
const payload = {tableLabel:'T1',items:[{title:'Καφές',quantity:2,modifiers:[{titleSnapshot:'Γάλα'}]}],order:{items:[{title:'DO NOT PRINT'}]}};
const text=iconv.decode(renderLocalTicket(payload,{}),'cp1253');
assert.ok(text.includes('Καφές')); assert.ok(text.includes('Γάλα')); assert.ok(!text.includes('DO NOT PRINT'));
assert.ok(!renderLocalTicket({note:'x\\x1by'},{}).subarray(5).includes(0x1b));
await enqueueLocalPrint('noor/orders/placed/printer_1',payload);
await enqueueLocalPrint('noor/orders/placed/printer_1',{tableLabel:'T2',items:[{title:'SECOND',quantity:1}]});
for(let i=0;i<100;i++){const s=await localPrintStatus('noor'); if(!s.jobs.length)break; await new Promise(r=>setTimeout(r,100));}
const status=await localPrintStatus('noor');assert.deepEqual(status.jobs,[]);
"""
    script = script.replace('/app', core_root.as_posix())
    child = subprocess.Popen(["node", "--input-type=module", "-e", script], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    received = b""
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            received += os.read(master, 65536)
        if child.poll() is not None:
            break
    stdout, stderr = child.communicate(timeout=5)
    assert child.returncode == 0, stderr.decode()
    while select.select([master], [], [], 0)[0]:
        received += os.read(master, 65536)
    assert received.count(b"\x1b@") == 2, received
    assert "Καφές".encode("cp1253") in received
    assert received.index(b"T1") < received.index(b"T2")
    print("PASS: direct serial bytes, Greek encoding, per-printer filtering, ordered queue, and receipt control-byte sanitization")
    routes.write_text(json.dumps({"noor/orders/placed/printer_1": {"device": "/dev/rfcomm999"}}))
    failure_script = """
import assert from 'node:assert/strict';
import {startLocalPrinting, enqueueLocalPrint, localPrintStatus} from '/app/dist/lib/localPrinting.js';
await startLocalPrinting();
await enqueueLocalPrint('noor/orders/placed/printer_1',{items:[{title:'MISSING DEVICE'}]});
for(let i=0;i<100;i++){const s=await localPrintStatus('noor');if(s.jobs.some(j=>j.state==='uncertain'&&j.error))break;await new Promise(r=>setTimeout(r,100));}
const status=await localPrintStatus('noor');assert.equal(status.jobs.length,1);assert.equal(status.jobs[0].state,'uncertain');assert.ok(status.jobs[0].error);
""".replace('/app', core_root.as_posix())
    subprocess.run(["node", "--input-type=module", "-e", failure_script], env=env, capture_output=True, check=True)
    failed_jobs = list((pathlib.Path(temp) / "spool/uncertain").glob("*.json"))
    assert len(failed_jobs) == 1
    before = failed_jobs[0].read_bytes()
    restart_script = f"import {{startLocalPrinting}} from '{core_root.as_posix()}/dist/lib/localPrinting.js';await startLocalPrinting();"
    subprocess.run(["node", "--input-type=module", "-e", restart_script], env=env, capture_output=True, check=True)
    assert failed_jobs[0].read_bytes() == before
    print("PASS: missing printer records an uncertain job; restart does not automatically reprint it")
os.close(master)
os.close(slave)
