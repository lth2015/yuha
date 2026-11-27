"""The client for the Qwen3-ForcedAligner worker, against fake workers (no model, no GPU)."""
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import qwen_align


def fake_worker(body: str) -> str:
    d = tempfile.mkdtemp()
    p = Path(d) / "worker.py"
    p.write_text(textwrap.dedent(body))
    return str(p)


ECHO = """
import json, sys
import numpy as np
for line in sys.stdin:
    req = json.loads(line)
    wav = np.load(req["npy"])
    print("noise a library printed", file=sys.stderr)
    units = [[c, 1.0 + i * 0.25, 1.25 + i * 0.25] for i, c in enumerate(req["text"].replace(" ", ""))]
    sys.stdout.write(json.dumps({"id": req["id"], "units": units, "samples": len(wav), "language": req["language"]}) + "\\n")
    sys.stdout.flush()
"""


class QwenClientTests(unittest.TestCase):
    def setUp(self):
        qwen_align.stop()

    def tearDown(self):
        qwen_align.stop()

    def run_with(self, worker: str, **env):
        return patch.dict(os.environ, {"QWEN_PYTHON": sys.executable, "QWEN_WORKER": worker, **env})

    def test_the_lyrics_go_in_and_timed_units_come_back(self):
        with self.run_with(fake_worker(ECHO)):
            units = qwen_align.align(np.zeros(16000, dtype=np.float32), "[verse]\n晚风\n等你", "zh")
        self.assertEqual([u[0] for u in units], ["晚", "风", "等", "你"])
        self.assertEqual(units[0], ("晚", 1.0, 1.25))

    def test_the_worker_is_started_once_and_kept(self):
        with self.run_with(fake_worker(ECHO)):
            qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en")
            first = qwen_align.status()["pid"]
            qwen_align.align(np.zeros(160, dtype=np.float32), "b", "en")
            self.assertEqual(qwen_align.status()["pid"], first)

    def test_a_worker_error_is_raised_and_the_worker_kept(self):
        worker = fake_worker("""
            import json, sys
            for line in sys.stdin:
                req = json.loads(line)
                sys.stdout.write(json.dumps({"id": req["id"], "error": "RuntimeError('no weights')"}) + "\\n")
                sys.stdout.flush()
        """)
        with self.run_with(worker):
            with self.assertRaisesRegex(RuntimeError, "no weights"):
                qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en")
            self.assertIsNotNone(qwen_align.status()["pid"])

    def test_a_worker_that_dies_is_started_again_next_time(self):
        worker = fake_worker("""
            import json, sys, os
            flag = os.environ["FLAG"]
            for line in sys.stdin:
                req = json.loads(line)
                if not os.path.exists(flag):
                    open(flag, "w").close()
                    sys.exit(3)
                sys.stdout.write(json.dumps({"id": req["id"], "units": [["a", 0.0, 1.0]]}) + "\\n")
                sys.stdout.flush()
        """)
        flag = os.path.join(tempfile.mkdtemp(), "died")
        with self.run_with(worker, FLAG=flag):
            with self.assertRaises(RuntimeError):
                qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en")
            self.assertEqual(qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en"), [("a", 0.0, 1.0)])

    def test_a_worker_that_hangs_is_given_up_on(self):
        worker = fake_worker("""
            import sys, time
            for line in sys.stdin:
                time.sleep(30)
        """)
        with self.run_with(worker, QWEN_TIMEOUT="1"):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en")
            self.assertIsNone(qwen_align.status()["pid"])

    def test_without_the_environment_it_says_so(self):
        with patch.dict(os.environ, {"QWEN_PYTHON": "/nonexistent/python"}):
            self.assertFalse(qwen_align.status()["installed"])
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                qwen_align.align(np.zeros(160, dtype=np.float32), "a", "en")


if __name__ == "__main__":
    unittest.main()
