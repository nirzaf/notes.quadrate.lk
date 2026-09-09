from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location(
        "qnotes_plugin",
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Unable to load the plugin package")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self, settings=None, response=None, error=None):
        self.settings = settings or {}
        self.response = response
        self.error = error
        self.commands = {}
        self.skills = []
        self.calls = []

    def register_command(self, name, handler, **kwargs):
        self.commands[name] = (handler, kwargs)

    def register_skill(self, name, path, **kwargs):
        self.skills.append((name, Path(path), kwargs))

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def call_mcp(self, server, tool, arguments, timeout=30):
        self.calls.append((server, tool, arguments, timeout))
        if self.error is not None:
            raise self.error
        return self.response


class PluginTests(unittest.TestCase):
    def test_registration_is_local_and_registers_expected_commands_and_skill(self):
        plugin = load_plugin()
        context = FakeContext()

        with patch("subprocess.Popen", side_effect=AssertionError("no subprocess")), patch(
            "socket.socket", side_effect=AssertionError("no network")
        ):
            plugin.register(context)

        self.assertEqual(set(context.commands), {"qnotes", "qnotes-help", "qnotes-status"})
        self.assertEqual(len(context.skills), 1)
        self.assertEqual(context.skills[0][0], "workflow")
        self.assertEqual(context.skills[0][1].name, "SKILL.md")

    def test_help_rejects_raw_arguments_without_echoing_them(self):
        plugin = load_plugin()
        context = FakeContext()
        plugin.register(context)
        handler = context.commands["qnotes-help"][0]
        token_like = "qnt_DO_NOT_ECHO_THIS"

        result = handler(token_like)

        self.assertEqual(result, "Usage: /qnotes-help")
        self.assertNotIn(token_like, result)

    def test_status_without_check_reads_only_safe_settings(self):
        plugin = load_plugin()
        context = FakeContext(
            settings={
                "server_name": "qnotes_custom",
                "notes_profile": "read",
                "vault_profile": "none",
            }
        )
        plugin.register(context)
        handler = context.commands["qnotes-status"][0]

        result = handler("")

        self.assertIn("Configured MCP server: qnotes_custom", result)
        self.assertIn("Configured Notes profile: read", result)
        self.assertIn("Configured Vault profile: none", result)
        self.assertIn("do not prove connectivity", result)
        self.assertEqual(context.calls, [])

    def test_status_probe_calls_only_list_notebooks_and_redacts_success_payload(self):
        plugin = load_plugin()
        context = FakeContext(
            response={
                "ok": True,
                "result": {
                    "items": [{"name": "private-notebook", "id": "secret-id"}],
                },
            }
        )
        plugin.register(context)
        handler = context.commands["qnotes-status"][0]

        result = handler("--check")

        self.assertEqual(context.calls, [("qnotes_read", "list_notebooks", {}, 10)])
        self.assertIn("Notes metadata check succeeded", result)
        self.assertNotIn("private-notebook", result)
        self.assertNotIn("secret-id", result)

    def test_status_probe_failures_are_safe_and_never_claim_success(self):
        plugin = load_plugin()
        cases = [
            (PermissionError("qnt_PRIVATE"), None),
            (RuntimeError("qvt_PRIVATE"), None),
            (None, {"ok": False, "error": "qnt_PRIVATE"}),
            (None, {"ok": True, "result": {"isError": True, "error": "qvt_PRIVATE"}}),
            (None, {"ok": True, "result": {"items": []}, "truncated": True}),
        ]

        for error, response in cases:
            with self.subTest(error=error, response=response):
                context = FakeContext(error=error, response=response)
                plugin.register(context)
                handler = context.commands["qnotes-status"][0]
                result = handler("--check")
                self.assertNotIn("qnt_PRIVATE", result)
                self.assertNotIn("qvt_PRIVATE", result)
                self.assertNotIn("Notes metadata check succeeded", result)

    def test_invalid_status_settings_fail_closed(self):
        plugin = load_plugin()
        context = FakeContext(settings={"server_name": "bad name", "notes_profile": "write", "vault_profile": "none"})
        plugin.register(context)

        result = context.commands["qnotes-status"][0]("--check")

        self.assertIn("settings are invalid", result)
        self.assertEqual(context.calls, [])


if __name__ == "__main__":
    unittest.main()
