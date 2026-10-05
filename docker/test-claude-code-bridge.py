"""Offline tests: runs a disposable FAKE CLI, never the installed Claude CLI."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


class BridgeTest(unittest.TestCase):
    def test_on_demand_boundary_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            executable = home / ".local/bin/claude"
            executable.parent.mkdir(parents=True)
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import os,sys,json,pathlib\n"
                "assert os.environ['CLAUDE_CODE_MAX_OUTPUT_TOKENS']=='1024'\n"
                "assert os.environ['MAX_THINKING_TOKENS']=='0'\n"
                "assert os.environ['CLAUDE_CODE_MAX_RETRIES']=='0'\n"
                "assert sys.argv[sys.argv.index('--tools')+1]==''\n"
                "assert '--system-prompt' in sys.argv\n"
                "assert '--disable-slash-commands' in sys.argv\n"
                "prompt=sys.stdin.read()\n"
                "with open(pathlib.Path.home()/'calls','a') as f: f.write('called\\n')\n"
                "print(json.dumps({'result':'Check the source entry path.','is_error':False}))\n"
            )
            executable.chmod(0o755)
            server = subprocess.Popen([sys.executable, str(Path(__file__).with_name("claude-code-bridge.py"))],
                                      env={**os.environ, "HOME": directory}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            endpoint = home / ".local/share/forge-claude/bridge/bridge.sock"
            try:
                for _ in range(100):
                    if endpoint.exists(): break
                    time.sleep(.02)
                self.assertTrue(endpoint.exists())
                self.assertFalse((home / "calls").exists(), "An idle service must never invoke Claude")

                def request(route, value):
                    client = http.client.HTTPConnection("localhost", timeout=5)
                    client.sock = socket.socket(socket.AF_UNIX)
                    client.sock.connect(str(endpoint))
                    client.request("POST", route, json.dumps(value), {"Content-Type": "application/json"})
                    response = client.getresponse()
                    result = response.status, json.loads(response.read())
                    client.close()
                    return result

                self.assertEqual(request("/completion", {})[0], 404)
                self.assertEqual(request("/review", {"model": "sonnet", "brief": "漢" * 1100})[0], 400)
                self.assertEqual(request("/review", {"model": "sonnet", "brief": ""})[0], 400)
                self.assertFalse((home / "calls").exists(), "Invalid requests must not invoke Claude")
                status, result = request("/review", {"model": "sonnet", "brief": "Why does a compiled development server resolve dist/client?"})
                self.assertEqual(status, 200)
                self.assertEqual(result["text"], "Check the source entry path.")
                self.assertEqual((home / "calls").read_text(), "called\n", "One request, one advisory CLI process")
            finally:
                server.terminate()
                server.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()