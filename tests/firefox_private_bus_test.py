import importlib.util
import json
import os
import shutil
import signal
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('firefox_adapter',Path(__file__).resolve().parents[1]/'native/firefox-desktop.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

DESKTOP={'DISPLAY':':0','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus','AT_SPI_BUS_ADDRESS':'unix:path=/run/user/1000/at-spi/bus_0',
         'XDG_RUNTIME_DIR':'/run/user/1000','WAYLAND_DISPLAY':'wayland-0'}

class LaunchEnvironmentTests(unittest.TestCase):
    # The hidden Firefox is started on its private buses, never the desktop's.
    def setUp(self):
        self.profile=tempfile.mkdtemp()
        self.started=[]
        self.patches=[patch.object(adapter,'AGENT_MODE',True),patch.object(adapter,'AGENT_PROFILE',self.profile),
                      patch.object(adapter,'VISIBLE_DISPLAY',':0'),patch.object(adapter,'ensure_agent_display',lambda:':90'),
                      patch.object(adapter,'agent_firefox_command',lambda:('/usr/bin/firefox',{})),
                      patch.object(adapter,'firefox_running',lambda:False),
                      patch.object(adapter.subprocess,'run',lambda argv,**options:self.started.append((argv,options))),
                      patch.dict(adapter.os.environ,DESKTOP)]
        for item in self.patches:item.start()
    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        shutil.rmtree(self.profile,ignore_errors=True)
    def test_firefox_gets_the_private_buses_and_no_portal(self):
        with patch.dict(adapter.private_bus,{'address':'unix:path=/x/toolsengine-bus-a/bus','accessibility':'unix:path=/x/toolsengine-bus-a/a11y','error':None}):
            adapter.start_agent_firefox(purpose='started')
        (argv,options),=self.started
        env=options['env']
        self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'],'unix:path=/x/toolsengine-bus-a/bus')
        self.assertEqual(env['AT_SPI_BUS_ADDRESS'],'unix:path=/x/toolsengine-bus-a/a11y')
        self.assertEqual(env['GTK_USE_PORTAL'],'0')
        self.assertEqual(env['DISPLAY'],':90')
        self.assertNotIn('WAYLAND_DISPLAY',env)
    def test_without_a_private_bus_firefox_is_not_started(self):
        with patch.dict(adapter.private_bus,{'address':None,'accessibility':None,'error':'no bus here'}):
            with self.assertRaisesRegex(ValueError,'no bus here'):adapter.start_agent_firefox(purpose='started')
        self.assertEqual(self.started,[])
    def test_a_hidden_firefox_on_another_bus_is_reported_not_driven(self):
        with patch.dict(adapter.private_bus,{'address':'unix:path=/x/toolsengine-bus-a/bus','accessibility':'a','error':None}), \
             patch.object(adapter,'foreign_bus_firefox',lambda:4242):
            with self.assertRaisesRegex(ValueError,'process 4242.*another session bus'):adapter.agent_bus_ready()
    def test_the_agent_profile_keeps_dialogs_in_firefox(self):
        adapter.ensure_agent_accessibility(self.profile)
        prefs=Path(self.profile,'user.js').read_text()
        for line in ('"widget.use-xdg-desktop-portal.file-picker", 0','"alerts.useSystemBackend", false','"print.prefer_system_dialog", false',
                     '"network.protocol-handler.external-default", false','"browser.download.always_ask_before_handling_new_types", false'):
            self.assertIn(line,prefs)

@unittest.skipUnless(shutil.which('dbus-daemon') and any(os.path.isfile(p) for p in adapter.ACCESSIBILITY_CONFIGS),'needs dbus-daemon and at-spi2-core')
class PrivateBusTests(unittest.TestCase):
    # Real daemons: a session bus that starts nothing and an accessibility bus,
    # both private to the profile, rejoined by the next helper.
    def setUp(self):
        self.profile=tempfile.mkdtemp()
        self.patches=[patch.object(adapter,'AGENT_PROFILE',self.profile),patch.dict(adapter.os.environ,{'XDG_RUNTIME_DIR':self.profile})]
        for item in self.patches:item.start()
    def tearDown(self):
        saved=json.loads(Path(self.profile,'.toolsengine-bus.json').read_text()) if Path(self.profile,'.toolsengine-bus.json').exists() else {}
        for key in ('session','accessibility'):
            entry=saved.get(key)
            if entry and adapter._live_daemon(entry,Path(saved['folder'])/('bus' if key=='session' else 'a11y')):os.kill(entry['pid'],signal.SIGTERM)
        for item in reversed(self.patches):item.stop()
        time.sleep(0.2)
        shutil.rmtree(self.profile,ignore_errors=True)
    def test_private_buses_are_started_once_and_rejoined(self):
        session,a11y=adapter.start_private_bus()
        saved=json.loads(Path(self.profile,'.toolsengine-bus.json').read_text())
        folder=Path(saved['folder'])
        self.assertTrue(folder.name.startswith('toolsengine-bus-'))
        self.assertEqual(folder.stat().st_mode&0o777,0o700)
        self.assertEqual((session,a11y),('unix:path='+str(folder/'bus'),'unix:path='+str(folder/'a11y')))
        self.assertNotIn('<servicedir',(folder/'session.conf').read_text())
        self.assertEqual(adapter.start_private_bus(),(session,a11y))
        env=dict(item.split('=',1) for item in Path('/proc',str(saved['accessibility']['pid']),'environ').read_bytes().decode().split('\0') if '=' in item)
        self.assertEqual((env['DBUS_SESSION_BUS_ADDRESS'],env['AT_SPI_BUS_ADDRESS'],env['XDG_RUNTIME_DIR']),(session,a11y,str(folder)))
        for name in ('DISPLAY','WAYLAND_DISPLAY','XAUTHORITY'):self.assertNotIn(name,env)
    def test_a_dead_bus_is_replaced_and_its_folder_removed(self):
        adapter.start_private_bus()
        old=json.loads(Path(self.profile,'.toolsengine-bus.json').read_text())
        os.kill(old['session']['pid'],signal.SIGTERM);time.sleep(0.3)
        adapter.start_private_bus()
        new=json.loads(Path(self.profile,'.toolsengine-bus.json').read_text())
        self.assertNotEqual(new['folder'],old['folder'])
        self.assertFalse(Path(old['folder']).exists())
        self.assertFalse(adapter._live_daemon(old['accessibility'],Path(old['folder'])/'a11y'))

unittest.main()
