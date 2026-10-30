"""Opaque handoff boundaries, using inert fixtures only; never real credentials."""
import importlib.util
import json
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('secure_test_adapter', Path(__file__).resolve().parents[1] / 'native/firefox-desktop.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
Vault = adapter._secret_module.SecretVault
SECRET = 'Fixture-only-opaque-7z!'
DESTINATION = 'https://destination.invalid'


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.vault = Vault(lambda: self.now)

    def capture(self, value=SECRET, **kw):
        return self.vault.capture(['Password: ' + value], 'Password', DESTINATION, **kw)

    def test_capture_and_errors_never_return_values(self):
        captured = self.capture()
        self.assertNotIn(SECRET, json.dumps(captured))
        self.assertGreater(len(captured['handle']), 40)
        with self.assertRaises(ValueError) as error:
            self.vault.capture(['Password: fixture-secret-one\nPassword: fixture-secret-two'], 'Password', DESTINATION)
        self.assertNotIn('fixture-secret-', str(error.exception))

    def test_literal_label_and_duplicate_accessibility_text(self):
        value = self.vault.capture(['API[0]: ' + SECRET] * 3, 'API[0]', DESTINATION)
        self.assertEqual(self.vault.consume(value['handle'], DESTINATION), SECRET.encode())

    def test_quoted_value_split_across_accessibility_nodes(self):
        captured = self.vault.capture(['Password: “', SECRET, '”'], 'Password', DESTINATION)
        self.assertEqual(captured['sourceFormat'], 'quoted-token')
        self.assertEqual(self.vault.consume(captured['handle'], DESTINATION), SECRET.encode())

    def test_prose_credential_and_later_instruction_require_precise_label(self):
        source = 'Your temporary password is “' + SECRET + '”.\nTo change your password: Use the passwd command.'
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.vault.capture([source], 'Password', DESTINATION)
        captured = self.vault.capture([source], 'temporary password', DESTINATION)
        self.assertEqual(self.vault.consume(captured['handle'], DESTINATION), SECRET.encode())

    def test_prose_label_with_colon_and_inline_fragments(self):
        for separator in [' is:', ' is: ', ' is = ', ' is ']:
            with self.subTest(separator=separator):
                captured = self.vault.capture(['Your temporary password' + separator, SECRET], 'temporary password', DESTINATION)
                self.assertEqual(self.vault.consume(captured['handle'], DESTINATION), SECRET.encode())

    def test_quoted_and_unquoted_distinct_values_are_ambiguous(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.vault.capture(['Password: "fixture-one"\nPassword: fixture-two'], 'Password', DESTINATION)

    def test_isolated_opening_quote_is_not_a_credential(self):
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.vault.capture(['Password: “'], 'Password', DESTINATION)

    def test_collapsed_or_masked_placeholders_are_not_credential_handles(self):
        for value in ['...', '…', '***', '•••']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'placeholder'):
                self.capture(value)

    def test_expiry_erases_buffer(self):
        handle = self.capture(ttl=10)
        buffer = self.vault.entries[handle['handle']]['value']
        self.now = 110
        with self.assertRaises(ValueError):
            self.vault.consume(handle['handle'], DESTINATION)
        self.assertEqual(buffer, bytes(len(buffer)))

    def test_idle_expiry_erases_without_a_followup_tool_call(self):
        vault = Vault()
        captured = vault.capture(['Password: ' + SECRET], 'Password', DESTINATION, ttl=10)
        original = vault.entries[captured['handle']]['value']
        redaction = vault.redactions[0][1]
        time.sleep(10.3)
        self.assertEqual(original, bytes(len(original)))
        self.assertEqual(redaction, bytes(len(redaction)))
        self.assertFalse(vault.entries)

    def test_handle_one_use_and_destination_bound(self):
        handle = self.capture()['handle']
        buffer = self.vault.entries[handle]['value']
        with self.assertRaises(ValueError):
            self.vault.consume(handle, 'https://other.invalid')
        self.assertEqual(buffer, bytes(len(buffer)))
        with self.assertRaises(ValueError):
            self.vault.consume(handle, DESTINATION)
        handle = self.capture()['handle']
        self.vault.consume(handle, DESTINATION)
        with self.assertRaises(ValueError):
            self.vault.consume(handle, DESTINATION)

    def test_malformed_destination_also_erases_consumed_value(self):
        handle = self.capture()['handle']
        buffer = self.vault.entries[handle]['value']
        with self.assertRaises(ValueError):
            self.vault.consume(handle, 'https://destination.invalid/path')
        self.assertEqual(buffer, bytes(len(buffer)))

    def test_origins_disallow_cleartext_remote_urls_and_credentials(self):
        for value in ['http://destination.invalid', 'https://name:password@destination.invalid',
                      'https://destination.invalid/path', 'https://destination.invalid?x=1', 'file:///tmp/key']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.vault.capture(['Password: ' + SECRET], 'Password', value)
        self.assertEqual(adapter._secret_module.exact_origin('http://localhost:8767'), 'http://localhost:8767')

    def test_revocation_and_clear_erase_buffers(self):
        handle = self.capture()['handle']
        buffer = self.vault.entries[handle]['value']
        self.vault.revoke(handle)
        self.assertEqual(buffer, bytes(len(buffer)))
        redaction = self.vault.redactions[0][1]
        self.vault.clear()
        self.assertEqual(redaction, bytes(len(redaction)))

    def test_redaction_survives_consumption_and_handles_json_escaping(self):
        secret = 'quoted-"-backslash-\\-fixture'
        handle = self.capture(secret)['handle']
        self.vault.consume(handle, DESTINATION)
        data = {'error': secret, 'snapshot': json.dumps(secret), 'ok': True}
        result = self.vault.sanitize(data)
        self.assertNotIn(secret, str(result))
        self.assertNotIn('quoted-', json.dumps(result))
        self.assertTrue(result['ok'])

    def test_secret_matching_protocol_vocabulary_cannot_corrupt_transport(self):
        self.capture('result')
        self.assertEqual(self.vault.sanitize({'id': 1, 'result': 'result'}),
                         {'id': 1, 'result': '[credential redacted]'})


class PasswordField:
    def get_role_name(self): return 'password text'
    def get_text_iface(self): raise AssertionError('Password values must never be read')


class DocumentTests(unittest.TestCase):
    def node(self, role, url=None, kids=()):
        node = Mock()
        node.get_role_name.return_value = role
        node.get_document_iface.return_value.get_document_attribute_value.return_value = url
        node.kids = list(kids)
        return node

    def test_native_chrome_document_frame_is_not_the_credential_source(self):
        document = self.node('document web', DESTINATION + '/login')
        frame = self.node('frame', kids=[self.node('document frame', 'about:blank'), document])
        states = Mock(); states.contains.return_value = True
        with patch.multiple(adapter, window=Mock(return_value=('owned', frame, 1)),
                            children=lambda n:n.kids, fresh_states=Mock(return_value=states)):
            self.assertIs(adapter.credential_document(DESTINATION), document)
            with self.assertRaises(ValueError): adapter.credential_document('https://wrong.invalid')

    def test_subframe_is_not_traversed_for_capture_or_password_selection(self):
        hidden = self.node('password text')
        subframe = self.node('document web', DESTINATION + '/frame', [hidden])
        document = self.node('document web', DESTINATION + '/login', [subframe])
        states = Mock(); states.contains.return_value = False
        with patch.multiple(adapter, children=lambda n:n.kids, fresh_states=Mock(return_value=states)):
            self.assertEqual(list(adapter.credential_nodes(document)), [document])

    def test_inline_accessibility_children_are_expanded_once_in_source_order(self):
        child = self.node('static', kids=[]); child.value = SECRET
        parent = self.node('paragraph', kids=[child]); parent.value = 'Password: \uFFFC'
        for node in [parent, child]:
            node.get_interfaces.return_value = ['Text']
            node.get_text_iface.return_value = node
        states = Mock(); states.contains.return_value = True
        seen = set()
        with patch.multiple(adapter, children=lambda n:n.kids, fresh_states=Mock(return_value=states)), \
                patch.object(adapter.Atspi.Text, 'get_character_count', side_effect=lambda n:len(n.value)), \
                patch.object(adapter.Atspi.Text, 'get_text', side_effect=lambda n,a,b:n.value[a:b]):
            self.assertEqual(adapter.credential_text(parent, seen), 'Password: ' + SECRET)
            self.assertEqual(adapter.credential_text(child, seen), '')

    def test_private_control_lookup_returns_only_reference(self):
        document = object()
        button = self.node('push button')
        button.get_name.return_value = 'Show source'
        password = PasswordField()
        states = Mock(); states.contains.return_value = True
        with patch.multiple(adapter, credential_document=Mock(return_value=document),
                            credential_nodes=Mock(return_value=[password, button]),
                            fresh_states=Mock(return_value=states),
                            window=Mock(return_value=('owned', None, 1)), actionable=Mock()):
            result = adapter.find_named_control({'origin': DESTINATION, 'name': 'Show source', 'role': 'push button'})
            self.assertEqual(set(result), {'ref', 'found'})
            self.assertIs(adapter.receipts[result['ref']][0], button)
            with self.assertRaisesRegex(ValueError, 'Exactly one'):
                adapter.find_named_control({'origin': DESTINATION, 'name': 'Absent', 'role': 'push button'})

    def test_private_control_lookup_matches_a_button_role_as_push_button(self):
        # AT-SPI 2.62 reports Firefox buttons with the role "button".
        document = object()
        button = self.node('button')
        button.get_name.return_value = 'Show source'
        states = Mock(); states.contains.return_value = True
        with patch.multiple(adapter, credential_document=Mock(return_value=document),
                            credential_nodes=Mock(return_value=[PasswordField(), button]),
                            fresh_states=Mock(return_value=states),
                            window=Mock(return_value=('owned', None, 1)), actionable=Mock()):
            result = adapter.find_named_control({'origin': DESTINATION, 'name': 'Show source', 'role': 'push button'})
            self.assertEqual(set(result), {'ref', 'found'})
            self.assertEqual(adapter.receipts[result['ref']][:1] + adapter.receipts[result['ref']][2:4],
                             (button, 'push button', 'Show source'))
            with self.assertRaisesRegex(ValueError, 'Only named button and link'):
                adapter.find_named_control({'origin': DESTINATION, 'name': 'Show source', 'role': 'button'})

    def test_inline_password_child_is_never_read(self):
        password = self.node('password text')
        password.get_text_iface.side_effect = AssertionError('Protected child read')
        with patch.object(adapter, 'fresh_states') as states:
            self.assertEqual(adapter.credential_text(password, set()), '')
        password.get_text_iface.assert_not_called()


class FillTests(unittest.TestCase):
    def setUp(self):
        self.vault = Vault()
        self.handle = self.vault.capture(['Password: ' + SECRET], 'Password', DESTINATION)['handle']
        self.buffer = self.vault.entries[self.handle]['value']
        self.request = {'handle': self.handle, 'destinationOrigin': DESTINATION}
        self.document = object()
        self.field = PasswordField()
        self.calls = []

    def fill(self, fields=None, interrupt=None, run=None, doc=None):
        def execute(argv, **kwargs):
            self.calls.append((argv, bytes(kwargs['input'])))
            return SimpleNamespace(returncode=0)
        states = Mock(); states.contains.return_value = True
        with patch.multiple(adapter, secret_vault=self.vault,
                            credential_document=doc or Mock(return_value=self.document),
                            credential_nodes=Mock(return_value=[self.field] if fields is None else fields),
                            fresh_states=Mock(return_value=states), give_focus=Mock(return_value='0x1'),
                            interrupted=interrupt or Mock(return_value=None), send=Mock(), note_input=Mock()), \
                patch.object(adapter.subprocess, 'run', side_effect=run or execute):
            return adapter.fill_credential(self.request)

    def test_only_process_stdin_receives_value_no_argv_or_password_readback(self):
        result = self.fill()
        self.assertTrue(result['entered'])
        self.assertFalse(result['submitted'])
        self.assertEqual(b''.join(value for _, value in self.calls), SECRET.encode())
        self.assertNotIn(SECRET, str([argv for argv, _ in self.calls]))
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(self.buffer, bytes(len(self.buffer)))
        self.assertNotIn(self.handle, self.vault.entries)

    def test_duplicate_or_absent_password_target_cannot_receive_secret(self):
        for fields in ([], [self.field, self.field]):
            self.setUp()
            with self.assertRaises(ValueError): self.fill(fields=fields)
            self.assertFalse(self.calls)
            self.assertEqual(self.buffer, bytes(len(self.buffer)))

    def test_wrong_actual_origin_is_rejected_before_input(self):
        with self.assertRaises(ValueError):
            self.fill(doc=Mock(side_effect=ValueError('Origin changed')))
        self.assertFalse(self.calls)
        self.assertEqual(self.buffer, bytes(len(self.buffer)))

    def test_focus_loss_stops_before_first_secret_chunk(self):
        with self.assertRaises(ValueError): self.fill(interrupt=Mock(return_value='focus lost'))
        self.assertFalse(self.calls)

    def test_focus_loss_between_chunks_stops_and_does_not_retry(self):
        result = self.fill(interrupt=Mock(side_effect=[None, None, None, 'focus lost']))
        self.assertIsNone(result['entered'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.calls[0][1]), 16)
        self.assertNotIn(self.handle, self.vault.entries)

    def test_provider_error_never_echoes_secret_and_is_reported_uncertain(self):
        result = self.fill(run=Mock(side_effect=RuntimeError(SECRET)))
        self.assertIsNone(result['entered'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(self.buffer, bytes(len(self.buffer)))

    def test_capture_provider_failure_cannot_echo_source_text(self):
        with patch.multiple(adapter, AGENT_MODE=False, secret_vault=self.vault,
                            capture_credential=Mock(side_effect=RuntimeError(SECRET))):
            with self.assertRaises(ValueError) as error:
                adapter.operate({'op':'capture_credential'})
        self.assertNotIn(SECRET, str(error.exception))


if __name__ == '__main__':
    unittest.main()
