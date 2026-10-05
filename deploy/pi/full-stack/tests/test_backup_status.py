import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('backup_update', DIRECTORY / 'update.py')
update = importlib.util.module_from_spec(SPEC)
with patch.object(sys, 'path', [str(DIRECTORY), *sys.path]):
    SPEC.loader.exec_module(update)


class BackupMetadataTests(unittest.TestCase):
    def test_metadata_contains_only_safe_timestamp_and_source(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            update.record_backup_status(directory)
            record = json.loads((directory / 'runtime-status/backup.json').read_text())
            self.assertEqual(set(record), {'source', 'lastSuccessfulAt'})
            self.assertEqual(record['source'], 'deployment')
            self.assertIsNotNone(update.datetime.fromisoformat(record['lastSuccessfulAt']).tzinfo)
            self.assertEqual(len(list((directory / 'runtime-status').iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
