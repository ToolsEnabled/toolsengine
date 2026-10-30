import importlib.util
import json
import math
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

spec=importlib.util.spec_from_file_location('firefox_adapter',Path(__file__).resolve().parents[1]/'native/firefox-desktop.py')
adapter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class Control:
    def get_role_name(self):return 'entry'
    def get_name(self):return 'Fixture'

class FirefoxBoundaryTests(unittest.TestCase):
    def setUp(self):adapter.receipts.clear()
    def test_expired_unknown_and_wrong_window_refs_refuse_before_action(self):
        with self.assertRaisesRegex(ValueError,'Unknown/stale'):adapter.resolve('absent')
        obj=Control()
        adapter.receipts['old']=(obj,'window','entry','Fixture',time.monotonic()-100)
        with self.assertRaisesRegex(ValueError,'Stale'):adapter.resolve('old')
        adapter.window=lambda:('different',None,1)
        adapter.receipts['wrong']=(obj,'window','entry','Fixture',time.monotonic())
        with self.assertRaisesRegex(ValueError,'Stale'):adapter.resolve('wrong')
    def test_password_controls_refuse_without_reading_values(self):
        obj=Control();obj.get_role_name=lambda:'password text'
        adapter.window=lambda:('window',None,1)
        adapter.receipts['password']=(obj,'window','password text','Fixture',time.monotonic())
        with self.assertRaisesRegex(ValueError,'protected'):adapter.resolve('password')
    def test_non_browser_process_is_excluded(self):
        import os
        self.assertFalse(adapter.owner(os.getpid()))
    def test_window_inventory_has_distinct_ids_even_when_firefox_parent_indexes_repeat(self):
        class Frame:
            def get_role_name(self):return 'frame'
            def get_index_in_parent(self):return 0
        class App:
            def get_process_id(self):return 42
        desktop=object();app=App();first=Frame();second=Frame()
        with patch.object(adapter.Atspi,'get_desktop',return_value=desktop), patch.object(adapter,'firefox_pid',return_value=True), patch.object(adapter,'children',side_effect=lambda x:[app] if x is desktop else [first,second]):
            self.assertEqual([w[0] for w in adapter.windows()],['42:0','42:1'])

S=adapter.Atspi.StateType
REAL_OPEN_CHOOSER=adapter.open_chooser

class Node:
    """An AT-SPI accessible shaped like Firefox's, with no bus behind it."""
    def __init__(self,role='entry',name='Field',text=None,states=(S.ENABLED,),actions=(),kids=(),attributes=None,focusable=True):
        self.role,self.name,self.text,self.flags,self.actions=role,name,text,set(states),list(actions)
        self.kids,self.parent,self.attributes,self.focusable=list(kids),None,attributes or {},focusable
        self.done,self.focus_in=[],None
        self.interfaces=(['Text','EditableText'] if text is not None else [])+['Component']+(['Action'] if actions else [])
        for kid in self.kids:kid.parent=self
    def get_role_name(self):return self.role
    def get_name(self):return self.name
    def get_interfaces(self):return self.interfaces
    def get_attributes(self):return self.attributes
    def clear_cache(self):pass
    def get_state_set(self):
        # React inputs take DOM focus a few reads after grab_focus succeeds.
        if self.focus_in is not None:
            self.focus_in-=1
            if self.focus_in<=0:self.flags.add(S.FOCUSED);self.focus_in=None
        flags=set(self.flags)
        class States:
            def contains(self,state):return state in flags
        return States()
    def shown(self):return self.text() if callable(self.text) else self.text
    def get_text_iface(self):return self if self.text is not None else None
    def get_component_iface(self):
        node=self
        class Component:
            def grab_focus(self):
                if node.focusable and S.FOCUSED not in node.flags:node.focus_in=3
                return True
        return Component()
    def get_child_count(self):return len(self.kids)
    def get_child_at_index(self,i):return self.kids[i]
    def get_parent(self):return self.parent
    def get_action_iface(self):return self if self.actions else None
    def get_n_actions(self):return len(self.actions)
    def get_action_name(self,i):return self.actions[i]
    def do_action(self,i):self.done.append(self.actions[i]);return True
    def get_selection_iface(self):return self if self.role=='menu' else None

class FakeText:
    get_character_count=staticmethod(lambda node:len(node.shown()))
    get_text=staticmethod(lambda node,start,end:node.shown()[start:end])

class FakeSelection:
    get_n_selected_children=staticmethod(lambda menu:sum(S.SELECTED in k.flags for k in menu.kids))
    get_selected_child=staticmethod(lambda menu,i:[k for k in menu.kids if S.SELECTED in k.flags][i])

class Desktop:
    """Records what would go to xdotool and answers the foreground query. Nothing reaches the real desktop."""
    def __init__(self):self.commands=[];self.delays=[];self.on_command=lambda argv:None;self.active=lambda:'1'
    def run(self,argv,timeout=5):
        if argv[0]!='xdotool':raise AssertionError('unexpected desktop command '+argv[0])
        if argv[1]=='getactivewindow':return self.active()
        self.commands.append(('type',argv[-1]) if argv[1]=='type' else (argv[1],*argv[3:]))
        if argv[1]=='type':self.delays.append(argv[argv.index('--delay')+1])
        self.on_command(argv)
        return ''
    def typed(self):return [c[1] for c in self.commands if c[0]=='type']

def lagging(node,desktop,initial='',reads=3,extra='',page=lambda text:text,lands=lambda chunk,delay,index:chunk,enter='newline'):
    """Firefox applies queued keys over several reads, not when xdotool returns.
    A "\\n" inside typed text is the Linefeed key, which web editors ignore;
    Return and Shift+Return break the line, or send the message (enter='send').
    lands is what of a typed chunk arrives; extra is a selected completion an
    address bar or chooser appends until Delete; page is what the page does to
    the text. early lists chunks typed before the previous one showed."""
    state={'chunks':None,'reads':0,'extra':extra,'early':[],'last':None,'typed':0,'sent':[]}
    def on(argv):
        if argv[1]=='type':
            if state['last']=='type' and state['reads']<reads:state['early'].append(argv[-1])
            state['typed']+=1
            chunk=lands(argv[-1].replace('\n',''),argv[argv.index('--delay')+1],state['typed'])
            state.update(chunks=(state['chunks'] or [])+[chunk],reads=0,last='type')
        elif argv[-1] in ('Return','shift+Return'):
            if enter=='send':state['sent'].append(''.join(state['chunks'] or []));state.update(chunks=[],reads=reads,last='key')
            else:state.update(chunks=(state['chunks'] or [])+['\n'],reads=0,last='key')
        elif argv[-1]=='BackSpace':state.update(chunks=[],reads=reads)
        elif argv[-1]=='Delete':state['extra']=''
    def text():
        if state['chunks'] is None:return initial
        state['reads']+=1
        chunks=state['chunks'];last=chunks[-1] if chunks else ''
        shown=''.join(chunks[:-1])+last[:len(last)*min(state['reads'],reads)//reads]
        if state['reads']>=reads:shown+=state['extra']
        return page(shown)
    desktop.on_command=on
    node.text=text
    return state

def after_command(desktop,when,effect):
    """Run effect once the recorded commands satisfy when, after the normal handling."""
    handle=desktop.on_command
    def on(argv):
        handle(argv)
        if when(desktop.commands):effect()
    desktop.on_command=on

def combo(names,selected=0,disabled=()):
    options=[Node('menu item',n,states=(() if i in disabled else (S.ENABLED,))+((S.SELECTED,) if i==selected else ())) for i,n in enumerate(names)]
    menu=Node('menu','',kids=options)
    return Node('combo box','Gender',kids=[menu],actions=['open']),options

def arrow_keys(desktop,options,lag=0.0):
    """Firefox moves a closed <select> one enabled option per arrow key."""
    def on(argv):
        presses=argv[3:] if argv[1]=='key' else []
        def apply():
            for key in presses:
                if key not in ('Down','Up'):continue
                current=next(i for i,o in enumerate(options) if S.SELECTED in o.flags)
                step=1 if key=='Down' else -1
                i=current+step
                while 0<=i<len(options) and S.ENABLED not in options[i].flags:i+=step
                if 0<=i<len(options):options[current].flags.discard(S.SELECTED);options[i].flags.add(S.SELECTED)
        threading.Timer(lag,apply).start() if lag else apply()
    desktop.on_command=on

class GuardedTest(unittest.TestCase):
    def setUp(self):
        adapter.receipts.clear()
        adapter.last_input.update(at=0.0,watch=None,until=0.0,commits=0)
        adapter.selected=None
        def refuse(*a,**k):raise AssertionError('a test tried to reach the real desktop')
        self.desktop=Desktop()
        for target,name,value in ((adapter,'run',self.desktop.run),(adapter.subprocess,'run',refuse),
                                  (adapter,'pump',lambda seconds=0.0:None),(adapter,'focus',lambda:'0x1'),
                                  (adapter.Atspi,'Text',FakeText),(adapter.Atspi,'Selection',FakeSelection),
                                  (adapter,'SETTLE',0.0),(adapter,'STALL',0.2),(adapter,'CHUNK_WAIT',0.3),(adapter,'QUIET',0.3)):
            patcher=patch.object(target,name,value);patcher.start();self.addCleanup(patcher.stop)
    def ref(self,node):
        patcher=patch.object(adapter,'resolve',lambda ref:node);patcher.start();self.addCleanup(patcher.stop)
        return 'f1'

class TypingTests(GuardedTest):
    def test_keys_wait_for_late_focus_and_success_waits_for_the_whole_text(self):
        field=Node('entry','Title',text='',states=(S.ENABLED,S.SINGLE_LINE))
        state=lagging(field,self.desktop,initial='old')
        focused_at_first_key=[]
        apply=self.desktop.on_command
        def on(argv):
            focused_at_first_key.append(S.FOCUSED in field.flags);apply(argv)
        self.desktop.on_command=on
        result=adapter.enter_text(field,'Software Engineer',False)
        self.assertIn('confirmed',result)
        self.assertEqual(self.desktop.commands,[('key','ctrl+a'),('type','Software Engineer')])
        self.assertTrue(all(focused_at_first_key),'keys were sent before Firefox reported focus')
        self.assertGreaterEqual(state['reads'],3,'success returned before Firefox showed the whole text')
    def test_focus_that_never_arrives_types_nothing(self):
        field=Node('entry','Organization',text='',states=(S.ENABLED,S.SINGLE_LINE),focusable=False)
        with self.assertRaisesRegex(ValueError,'no keys were sent'):adapter.enter_text(field,'ToolsEnabled',False)
        self.assertEqual(self.desktop.commands,[])
    def test_text_that_never_shows_stops_typing_and_later_focus_changes_wait_for_it(self):
        field=Node('entry','Title',text='Softw')
        self.assertEqual(adapter.confirm_text(field,'Software',0.2),'Softw')
        field.flags.add(S.FOCUSED)
        with self.assertRaisesRegex(ValueError,'Typing stopped after 8 of 8 characters: Firefox did not show .*"Softw"'):
            adapter.enter_text(field,'Software',False)
        self.assertIsNotNone(adapter.last_input['watch'])
    def test_drain_holds_focus_changes_until_the_control_stops_changing(self):
        values=iter(['S','So','Sof','Soft']+['Soft']*1000)
        adapter.note_input(lambda:next(values),5)
        started=time.monotonic()
        adapter.drain()
        self.assertGreaterEqual(time.monotonic()-started,1.0)
        self.assertIsNone(adapter.last_input['watch'])
    def test_rich_editor_paragraphs_are_compared_without_their_breaks(self):
        editor=Node('entry','Message',text='￼￼',states=(S.ENABLED,S.MULTI_LINE),
                    kids=[Node('paragraph','',text='Dear team,'),Node('paragraph','',text='Thanks')])
        self.assertEqual(adapter.text_of(editor),('Dear team,Thanks',True))
        self.assertIsNone(adapter.confirm_text(editor,'Dear team,\nThanks',0.2))
    def test_tabs_and_single_line_breaks_are_refused_before_any_key(self):
        field=Node('entry','Name',text='',states=(S.ENABLED,S.SINGLE_LINE))
        with self.assertRaisesRegex(ValueError,'single-line'):adapter.enter_text(field,'a\nb',False)
        with self.assertRaisesRegex(ValueError,'tab character'):adapter.enter_text(field,'a\tb',False)
        self.assertEqual(self.desktop.commands,[])
    def test_empty_text_clears_the_control(self):
        field=Node('entry','Name',text='',states=(S.ENABLED,S.SINGLE_LINE))
        lagging(field,self.desktop,initial='old')
        self.assertIn('confirmed',adapter.enter_text(field,'',False))
        self.assertEqual(self.desktop.commands,[('key','ctrl+a'),('key','BackSpace')])
    def test_text_the_control_already_shows_is_not_typed_again(self):
        field=Node('entry','Location',text='Riverside, CA',states=(S.ENABLED,S.SINGLE_LINE))
        self.assertIn('already shows exactly that text; nothing was typed',adapter.enter_text(field,'Riverside, CA',False))
        self.assertEqual(self.desktop.commands,[])

class ChunkTests(GuardedTest):
    paragraph=lambda name:(name+': '+'reliable agent tooling, measured and shipped. '*8).strip()
    letter=paragraph('Paragraph one')+'\n\n'+paragraph('Paragraph two')
    def field(self,**options):
        node=Node('entry','Cover letter',text='',states=(S.ENABLED,S.MULTI_LINE))
        return node,lagging(node,self.desktop,**options)
    def test_long_text_goes_out_in_chunks_each_after_the_previous_one_showed(self):
        node,state=self.field()
        self.assertIn('confirmed',adapter.enter_text(node,self.letter,False))
        self.assertEqual([len(t) for t in self.desktop.typed()],[150,150,len(self.letter)//2-301,150,150,len(self.letter)//2-301])
        self.assertEqual(''.join(self.desktop.typed()),self.letter.replace('\n',''))
        self.assertEqual(self.desktop.commands.count(('key','Return')),2)
        self.assertEqual(state['early'],[],'a chunk went out before Firefox showed the previous one')
    def test_lost_focus_or_foreground_stops_typing_at_a_chunk_boundary(self):
        node,_=self.field()
        after_command(self.desktop,lambda c:len([x for x in c if x[0]=='type'])==2,lambda:node.flags.discard(S.FOCUSED))
        with self.assertRaisesRegex(ValueError,f'Typing stopped after 300 of {len(self.letter)} characters: the control lost focus'):
            adapter.enter_text(node,self.letter,False)
        self.assertEqual(len(self.desktop.typed()),2)
        self.setUp()
        node,_=self.field()
        after_command(self.desktop,lambda c:len([x for x in c if x[0]=='type'])==1,lambda:setattr(self.desktop,'active',lambda:'7'))
        with self.assertRaisesRegex(ValueError,'Typing stopped after 150 of .*Firefox stopped being the foreground window'):
            adapter.enter_text(node,self.letter,False)
        self.assertEqual(len(self.desktop.typed()),1)
    def test_blank_lines_dropped_by_the_page_are_named_and_do_not_stop_typing(self):
        node,_=self.field(page=lambda text:text.replace('\n\n',''))
        with self.assertRaisesRegex(ValueError,'the page dropped 2 of 2 line breaks; every other character matches'):
            adapter.enter_text(node,self.letter,False)
        self.assertEqual(''.join(self.desktop.typed()),self.letter.replace('\n',''))
    def test_a_control_that_stops_taking_text_ends_typing_after_one_slow_retry(self):
        node,_=self.field(page=lambda text:text[:195])
        with self.assertRaisesRegex(ValueError,f'Typing stopped after 345 of {len(self.letter)} characters: Firefox did not show .* The control shows 195 characters'):
            adapter.enter_text(node,self.letter,False)
        self.assertEqual(self.desktop.typed()[2],self.letter[195:345],'the retry resumed from what the control held')
        self.assertEqual(self.desktop.delays,['5','5','25'])

class NewlineTests(GuardedTest):
    def field(self):
        return Node('entry','About',text='',states=(S.ENABLED,S.MULTI_LINE))
    def test_line_breaks_go_out_as_enter_key_presses_not_inside_the_typed_text(self):
        node=self.field();lagging(node,self.desktop)
        self.assertIn('confirmed',adapter.enter_text(node,'Line one\nLine two\n\nLine four',False))
        self.assertEqual(self.desktop.commands,[('key','ctrl+a'),('type','Line one'),('key','Return'),('type','Line two'),
                                                ('key','Return'),('key','Return'),('type','Line four')])
        self.assertFalse(any('\n' in typed for typed in self.desktop.typed()))
    def test_shift_enter_is_used_where_enter_would_send(self):
        node=self.field();lagging(node,self.desktop)
        adapter.enter_text(node,'Hi there\nSecond line',False,newline='Shift+Enter')
        self.assertEqual(self.desktop.commands[2],('key','shift+Return'))
        self.assertNotIn(('key','Return'),self.desktop.commands)
    def test_an_enter_that_sent_the_message_is_reported_as_performed_not_failed(self):
        node=self.field();state=lagging(node,self.desktop,enter='send')
        result=adapter.dispatch({'op':'type','ref':self.ref(node),'text':'Hi there\nSecond line'})
        self.assertRegex(result,'^Line breaks were sent with Enter, and then the control no longer shows the text typed before it: Enter may have sent the message')
        self.assertEqual((state['sent'],self.desktop.typed()),(['Hi there'],['Hi there','Second line']))
    def test_unknown_newline_keys_and_control_characters_type_nothing(self):
        node=self.field()
        with self.assertRaisesRegex(ValueError,'newline must be'):adapter.enter_text(node,'a\nb',False,newline='Alt+Enter')
        with self.assertRaisesRegex(ValueError,'control characters'):adapter.enter_text(node,'a\x0bb',False)
        self.assertEqual(self.desktop.commands,[])

class RetryTests(GuardedTest):
    text='A'*150+'B'*150+'C'*124
    def field(self):
        return Node('entry','Description',text='',states=(S.ENABLED,S.MULTI_LINE))
    def test_a_chunk_that_lost_keys_is_retried_once_slowly_from_what_the_control_holds(self):
        node=self.field()
        lagging(node,self.desktop,lands=lambda chunk,delay,index:chunk[:50] if index==2 and delay=='5' else chunk)
        self.assertEqual(adapter.enter_text(node,self.text,False),
                         'Text entered and confirmed in the control (1 chunk retried more slowly). Inspect a fresh snapshot.')
        self.assertEqual(self.desktop.typed(),['A'*150,'B'*150,'B'*100+'C'*50,'C'*74],'text the control showed was typed again')
        self.assertEqual(self.desktop.delays,['5','5','25','25'])
    def test_a_retry_that_also_loses_keys_stops_without_a_second_retry(self):
        node=self.field()
        lagging(node,self.desktop,lands=lambda chunk,delay,index:chunk[:50] if index>=2 else chunk)
        with self.assertRaisesRegex(ValueError,'Typing stopped after 350 of 424 characters: Firefox did not show .* The control shows 250 characters'):
            adapter.enter_text(node,self.text,False)
        self.assertEqual(self.desktop.typed(),['A'*150,'B'*150,'B'*100+'C'*50])
    def test_no_retry_while_keys_may_still_be_arriving_or_the_control_holds_other_text(self):
        node=self.field();node.flags.add(S.FOCUSED)
        reads=[0]
        def trickle():
            # Keys still arriving: a character every ten reads, so every quiet window
            # sees a change but the chunk never completes. A retry now would type them twice.
            reads[0]+=1
            return 'A'*min(150,reads[0]//10)
        node.text=trickle
        with self.assertRaisesRegex(ValueError,'Typing stopped after 150 of 150'):adapter.enter_text(node,'A'*150,False)
        self.assertEqual(len(self.desktop.typed()),1)
        self.setUp()
        node=self.field();node.flags.add(S.FOCUSED);node.text='Zebra'
        with self.assertRaisesRegex(ValueError,'Typing stopped after 150 of 150'):adapter.enter_text(node,'A'*150,False)
        self.assertEqual(len(self.desktop.typed()),1)
    def test_landed_reads_rich_editors_and_refuses_other_text(self):
        self.assertEqual(adapter.landed('Dear team,Thanks','Dear team,\nThanks for'),16+1)
        self.assertEqual(adapter.landed('Hello wor\n','Hello world'),9)
        self.assertIsNone(adapter.landed('Hello there','Hello world'))
        self.assertEqual(adapter.landed('','Hello'),0)

class SubmitTests(GuardedTest):
    def test_enter_whose_post_check_fails_is_reported_as_performed(self):
        field=Node('entry','Email',text='',states=(S.ENABLED,S.SINGLE_LINE))
        lagging(field,self.desktop)
        after_command(self.desktop,lambda c:c[-1]==('key','Return'),lambda:setattr(self.desktop,'active',lambda:'9'))
        result=adapter.dispatch({'op':'type','ref':self.ref(field),'text':'owner@example.com','submit':True})
        self.assertRegex(result,'^Text entered and confirmed in the control. Enter was pressed; post-check failed: .*not the foreground window')
        self.assertEqual(self.desktop.commands.count(('key','Return')),1)
    def test_enter_is_not_pressed_when_the_control_lost_focus(self):
        field=Node('entry','Email',text='',states=(S.ENABLED,S.SINGLE_LINE))
        lagging(field,self.desktop)
        after_command(self.desktop,lambda c:c[-1][0]=='type',lambda:field.flags.discard(S.FOCUSED))
        with self.assertRaisesRegex(ValueError,'Text entered and confirmed in the control. Enter was NOT pressed: the control lost focus'):
            adapter.dispatch({'op':'type','ref':self.ref(field),'text':'owner@example.com','submit':True})
        self.assertNotIn(('key','Return'),self.desktop.commands)

class KeyTests(GuardedTest):
    def test_a_key_is_refused_before_sending_when_firefox_is_not_in_front(self):
        def behind():raise ValueError('Firefox is not the foreground window: another window kept focus, so nothing was done.')
        with patch.object(adapter,'focus',behind), self.assertRaisesRegex(ValueError,'nothing was done'):
            adapter.dispatch({'op':'key','key':'Enter'})
        self.assertEqual(self.desktop.commands,[])
    def test_post_action_focus_check_failure_reports_the_key_as_pressed(self):
        after_command(self.desktop,lambda c:c[-1]==('key','Return'),lambda:setattr(self.desktop,'active',lambda:'5'))
        result=adapter.dispatch({'op':'key','key':'Enter'})
        self.assertRegex(result,'^Action performed; post-check failed: Enter was pressed, but Firefox was not the foreground window right afterwards')
        self.assertIn('Do not repeat the action',result)
        self.assertEqual(self.desktop.commands,[('key','Return')])

class SelectTests(GuardedTest):
    names=['Select...','Female','Male','Decline to state']
    def test_option_is_chosen_by_name_with_exact_key_count_and_verified(self):
        box,options=combo(self.names,selected=0,disabled=(0,))
        arrow_keys(self.desktop,options,lag=0.3)
        self.assertEqual(adapter.select_option(box,'male'),'Selected "Male" (verified).')
        self.assertEqual(self.desktop.commands,[('key','Down','Down')],'keys accumulated or overshot')
        self.assertIn(S.SELECTED,options[2].flags)
    def test_upward_moves_and_neighbouring_names_are_not_confused(self):
        box,options=combo(self.names,selected=3)
        arrow_keys(self.desktop,options)
        self.assertEqual(adapter.select_option(box,'Female'),'Selected "Female" (verified).')
        self.assertEqual(self.desktop.commands,[('key','Up','Up')])
    def test_unknown_ambiguous_disabled_and_unchanged_options_send_no_keys(self):
        box,options=combo(self.names,selected=2,disabled=(0,))
        with self.assertRaisesRegex(ValueError,'No option is named "Other". Options: \\["Select...", "Female"'):adapter.select_option(box,'Other')
        with self.assertRaisesRegex(ValueError,'disabled'):adapter.select_option(box,'Select...')
        self.assertIn('unchanged',adapter.select_option(box,'Male'))
        twice,_=combo(['A','B','B'])
        with self.assertRaisesRegex(ValueError,'2 options are named "B"'):adapter.select_option(twice,'b')
        self.assertEqual(self.desktop.commands,[])
    def test_a_list_that_does_not_move_is_reported_without_more_keys(self):
        box,options=combo(self.names,selected=0)
        with self.assertRaisesRegex(ValueError,'The list shows "Select...", not "Male"'):adapter.select_option(box,'Male')
        self.assertEqual(self.desktop.commands,[('key','Down','Down')])
    def test_arrow_keys_stop_when_firefox_leaves_the_foreground(self):
        box,options=combo(self.names,selected=0)
        self.desktop.active=lambda:'4'
        with self.assertRaisesRegex(ValueError,'Firefox stopped being the foreground window, so no more arrow keys were sent'):
            adapter.select_option(box,'Male')
        self.assertEqual(self.desktop.commands,[])
    def test_page_made_comboboxes_are_sent_to_click(self):
        aria=Node('combo box','Location',kids=[Node('list box','Suggestions')],actions=['open'])
        with self.assertRaisesRegex(ValueError,'click the control'):adapter.select_option(aria,'Riverside')
    def test_snapshot_shows_the_selected_value_and_options(self):
        box,_=combo(self.names,selected=2)
        page=Node('document web','Application',states=(S.ENABLED,S.SHOWING),kids=[box])
        frame=Node('frame','Firefox',kids=[page])
        with patch.object(adapter,'window',return_value=('1:0',frame,1)):text=adapter.snapshot()
        self.assertIn('- combo box "Gender" value="Male" options=["Select...", "Female", "Male", "Decline to state"]',text)

class ActionTests(GuardedTest):
    def test_click_activates_before_delivery_and_does_not_reactivate_afterwards(self):
        events=[]
        button=Node('push button','Open menu',actions=['press'])
        def activate():events.append('focus');return '0x1'
        def click(i):events.append('click');button.done.append('press');return True
        button.do_action=click
        with patch.object(adapter,'focus',activate):adapter.action(button)
        self.assertEqual(events,['focus','click'])
        self.assertEqual(button.done,['press'])
    def test_failed_activation_delivers_no_click(self):
        button=Node('push button','Submit',actions=['press'])
        with patch.object(adapter,'focus',side_effect=ValueError('activation refused')):
            with self.assertRaisesRegex(ValueError,'activation refused'):adapter.action(button)
        self.assertEqual(button.done,[])
        self.assertEqual(adapter.last_input['commits'],0)
    def test_focus_race_before_delivery_delivers_no_click(self):
        button=Node('push button','Submit',actions=['press'])
        with patch.object(adapter,'foreground',return_value=2):
            with self.assertRaisesRegex(ValueError,'lost foreground focus'):adapter.action(button)
        self.assertEqual(button.done,[])
        self.assertEqual(adapter.last_input['commits'],0)
    def test_select_and_click_ancestor_actions_are_invoked_on_the_element(self):
        option=Node('list item','Software Engineer',actions=['select'])
        words=Node('paragraph','Apply now',actions=['clickAncestor'])
        for node in (option,words):
            self.assertEqual(adapter.action(node),'Action completed; inspect a fresh snapshot.')
        self.assertEqual((option.done,words.done),(['select'],['clickAncestor']))
    def test_an_element_without_actions_uses_its_nearest_actionable_ancestor_inside_the_page(self):
        label=Node('static','Jobs');link=Node('link','Jobs',actions=['jump'],kids=[label])
        Node('document web','Page',kids=[link])
        self.assertIn('nearest actionable ancestor (link "Jobs")',adapter.action(label))
        self.assertEqual(link.done,['jump'])
        stray=Node('static','Footer');Node('document web','Page',actions=['click'],kids=[Node('section','',kids=[stray])])
        with self.assertRaisesRegex(ValueError,'No supported accessibility action'):adapter.action(stray)
    def test_native_drop_downs_are_redirected_to_select_option(self):
        box,_=combo(['A','B'])
        with self.assertRaisesRegex(ValueError,'browser.select_option'):adapter.action(box)
        self.assertEqual(box.done,[])
    def test_a_click_whose_reply_is_lost_is_reported_as_performed_not_failed(self):
        submit=Node('push button','Submit',actions=['press'])
        def lost(i):submit.done.append('press');raise RuntimeError('Timeout was reached')
        submit.do_action=lost
        result=adapter.dispatch({'op':'click','ref':self.ref(submit)})
        self.assertRegex(result,'probably been performed. Do not repeat it')
        self.assertEqual(submit.done,['press'])
    def test_the_clicked_ancestor_is_described_before_the_page_goes_away(self):
        class Vanishing(Node):
            gone=False
            def do_action(self,i):self.gone=True;return super().do_action(i)
            def get_role_name(self):
                if self.gone:raise RuntimeError('The accessible is defunct')
                return super().get_role_name()
        words=Node('static','Submit');button=Vanishing('push button','Submit',actions=['press'],kids=[words])
        Node('document web','Form',kids=[button])
        self.assertEqual(adapter.dispatch({'op':'click','ref':self.ref(words)}),
                         'Action completed on the nearest actionable ancestor (push button "Submit"); inspect a fresh snapshot.')
    def test_a_refused_action_is_an_error_because_nothing_happened(self):
        button=Node('push button','Next',actions=['press'])
        button.do_action=lambda i:False
        with self.assertRaisesRegex(ValueError,'refused the accessibility action; nothing was done'):
            adapter.dispatch({'op':'click','ref':self.ref(button)})
    def test_failed_input_invalidates_references_but_refusals_do_not(self):
        adapter.receipts['f1']=('obj','w','entry','x',time.monotonic())
        with self.assertRaises(ValueError):adapter.dispatch({'op':'unknown'})
        self.assertIn('f1',adapter.receipts)
        def typed_then_failed(req):adapter.note_input();raise ValueError('uncertain')
        with patch.object(adapter,'operate',typed_then_failed), self.assertRaises(ValueError):adapter.dispatch({'op':'type'})
        self.assertEqual(adapter.receipts,{})

class RoleNameTests(GuardedTest):
    """AT-SPI 2.62 reports Firefox buttons with the role "button"; earlier releases said "push button"."""
    def test_the_button_role_is_read_as_push_button_and_other_roles_are_unchanged(self):
        for role,expected in (('button','push button'),('push button','push button'),('toggle button','toggle button'),
                              ('link','link'),('entry','entry'),('password text','password text')):
            self.assertEqual(adapter.role_of(Node(role,'X')),expected)
    def test_a_button_role_node_is_a_push_button_in_snapshots(self):
        button=Node('button','Apply',actions=['press'])
        idle=Node('button','',states=())
        page=Node('document web','Application',states=(S.ENABLED,S.SHOWING),kids=[button,idle])
        frame=Node('frame','Firefox',kids=[page])
        with patch.object(adapter,'window',return_value=('1:0',frame,1)):text=adapter.snapshot()
        self.assertRegex(text,r'- push button "Apply"[^\n]*\[ref=f[0-9a-f]+\]')
        self.assertRegex(text,r'- push button "" \[disabled\]')
        self.assertNotRegex(text,r'- button ')
        ref=next(r for r,receipt in adapter.receipts.items() if receipt[0] is button)
        self.assertEqual(adapter.receipts[ref][2],'push button')
        with patch.object(adapter,'window',return_value=('1:0',frame,1)):self.assertIs(adapter.resolve(ref),button)
    def test_a_button_role_node_is_clicked_and_described_as_a_push_button(self):
        words=Node('static','Submit');button=Node('button','Submit',actions=['press'],kids=[words])
        Node('document web','Form',kids=[button])
        self.assertEqual(adapter.dispatch({'op':'click','ref':self.ref(words)}),
                         'Action completed on the nearest actionable ancestor (push button "Submit"); inspect a fresh snapshot.')
        self.assertEqual(button.done,['press'])

class LaunchTests(GuardedTest):
    session={'DISPLAY':':0','HOME':'/home/owner','PATH':'/usr/bin','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus',
             'XAUTHORITY':'/run/user/1000/gdm/Xauthority','NOTIFY_SOCKET':'/run/systemd/notify','INVOCATION_ID':'unit'}
    def launch(self,windows,running=False,session=session,display=':0'):
        started=[]
        def record(argv,**options):started.append((argv,options))
        with patch.object(adapter,'windows',side_effect=windows), patch.object(adapter,'firefox_running',return_value=running), \
             patch.object(adapter,'desktop_session',return_value=session), patch.object(adapter.os,'access',return_value=True), \
             patch.object(adapter.subprocess,'run',record), patch.object(adapter,'LAUNCH_WAIT',0.05), patch.object(adapter,'EXPOSE_WAIT',0.05), \
             patch.dict(adapter.os.environ,{'DISPLAY':display,'TMPDIR':'/w/.toolsengine-runtime/tmp','CLAUDECODE':'1'}):
            try:return adapter.firefox_windows(),started
            except ValueError as error:return error,started
    def test_no_running_firefox_starts_the_owner_default_profile_in_his_desktop_session(self):
        ws,started=self.launch([[],[],[('1:0','frame',9)]])
        self.assertEqual(ws,[('1:0','frame',9)])
        (argv,options),=started
        self.assertEqual(argv,['/usr/bin/setsid','-f','/snap/bin/firefox','-P','default'])
        env=options['env']
        self.assertEqual((env['DISPLAY'],env['GNOME_ACCESSIBILITY'],env['HOME']),(':0','1','/home/owner'))
        for absent in ('NOTIFY_SOCKET','INVOCATION_ID','TMPDIR','CLAUDECODE'):self.assertNotIn(absent,env)
    def test_a_running_but_unexposed_firefox_is_not_started_twice(self):
        error,started=self.launch(lambda:[],running=True)
        self.assertRegex(str(error),'Firefox is running, but no same-owner Firefox window is exposed')
        self.assertEqual(started,[])
    def test_wrong_display_missing_session_and_missing_window_are_explained(self):
        error,started=self.launch(lambda:[],display=':1')
        self.assertRegex(str(error),"DISPLAY ':1' but the owner desktop is ':0'");self.assertEqual(started,[])
        error,started=self.launch(lambda:[],session=None)
        self.assertRegex(str(error),'gnome-shell');self.assertEqual(started,[])
        error,started=self.launch(lambda:[])
        self.assertRegex(str(error),'Started the owner.s Firefox');self.assertEqual(len(started),1)

class OpenTabTests(GuardedTest):
    url='https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=pp_url&'+'&'.join(f'entry.{i}=2014-15%20%28Berkeley%29' for i in range(60))
    def open(self,tabs,url=None):
        started=[]
        def record(argv,**options):started.append((argv,options))
        with patch.object(adapter,'tab_list',side_effect=tabs), patch.object(adapter,'desktop_session',return_value=LaunchTests.session), \
             patch.object(adapter.os,'access',return_value=True), patch.object(adapter.subprocess,'run',record), \
             patch.object(adapter,'TAB_WAIT',0.05), patch.dict(adapter.os.environ,{'DISPLAY':':0','TMPDIR':'/w/tmp'}):
            try:return adapter.dispatch({'op':'open_tab','url':url or self.url}),started
            except ValueError as error:return error,started
    def test_a_long_url_is_handed_to_firefox_and_its_new_tab_selected(self):
        self.assertGreater(len(self.url),1500)
        tab=lambda wid:('tab',wid,9,'Form',False)
        result,started=self.open([[tab('9:0'),tab('9:0')],[tab('9:0'),tab('9:0')],[tab('9:0'),tab('9:0'),tab('9:0')]])
        self.assertEqual(result,'Opened the URL in a new tab of Firefox window 9:0, which is now selected; inspect a fresh snapshot.')
        self.assertEqual(adapter.selected,'9:0')
        (argv,options),=started
        self.assertEqual(argv,['/usr/bin/setsid','-f','/snap/bin/firefox','-P','default','--new-tab',self.url])
        self.assertNotIn('TMPDIR',options['env'])
        self.assertEqual(self.desktop.commands,[],'nothing was typed')
    def test_a_tab_that_does_not_appear_is_reported_as_performed_not_failed(self):
        result,started=self.open(lambda:[('tab','9:0',9,'Form',True)])
        self.assertRegex(result,'^The URL was handed to Firefox, but no new tab appeared .* Do not repeat it')
        self.assertEqual(len(started),1)
    def test_urls_that_could_be_options_are_refused(self):
        error,started=self.open(lambda:[],url='--screenshot=/tmp/x')
        self.assertRegex(str(error),'Only HTTP')
        self.assertEqual(started,[])

class NavigateTests(GuardedTest):
    def navigate(self,bar,url):
        pressed=[]
        def keys(key,commit=True):pressed.append(key);return '0x1'
        with patch.object(adapter,'keys',keys), patch.object(adapter,'window',return_value=('1:0',None,1)), \
             patch.object(adapter,'chrome_entry',return_value=bar):
            try:return adapter.navigate(url),pressed
            except ValueError as error:return error,pressed
    def test_url_is_typed_only_into_the_focused_address_bar_and_confirmed_before_enter(self):
        bar=Node('entry','Search or enter address',text='',states=(S.ENABLED,S.FOCUSED))
        lagging(bar,self.desktop,extra='/jobs/')
        result,pressed=self.navigate(bar,'https://www.linkedin.com')
        self.assertEqual((result,pressed),('Navigation started; inspect a fresh snapshot.',['Control+l','Enter']))
        self.assertEqual(self.desktop.commands,[('type','https://www.linkedin.com'),('key','Delete')])
    def test_a_long_url_is_typed_in_chunks_and_enter_waits_for_all_of_it(self):
        bar=Node('entry','Search or enter address',text='',states=(S.ENABLED,S.FOCUSED))
        state=lagging(bar,self.desktop)
        url=OpenTabTests.url
        result,pressed=self.navigate(bar,url)
        self.assertEqual(pressed,['Control+l','Enter'])
        self.assertEqual(''.join(self.desktop.typed()),url)
        self.assertEqual(len(self.desktop.typed()),math.ceil(len(url)/adapter.CHUNK))
        self.assertEqual(state['early'],[])
    def test_no_address_bar_or_wrong_text_presses_no_enter(self):
        pressed=[]
        with patch.object(adapter,'keys',lambda key,commit=True:pressed.append(key) or '0x1'), patch.object(adapter,'window',return_value=('1:0',None,1)), \
             patch.object(adapter,'chrome_entry',return_value=None), patch.object(adapter.time,'monotonic',side_effect=[0,0,10,10,10]):
            with self.assertRaisesRegex(ValueError,'nothing was typed'):adapter.navigate('https://example.com')
        self.assertEqual((pressed,self.desktop.commands),(['Control+l'],[]))
        bar=Node('entry','Search',text='https://exam',states=(S.ENABLED,S.FOCUSED))
        error,pressed=self.navigate(bar,'https://example.com')
        self.assertRegex(str(error),'The URL was not entered .*Enter was not pressed')
        self.assertNotIn('Enter',pressed)

class UploadTests(GuardedTest):
    def setUp(self):
        super().setUp()
        self.root=tempfile.mkdtemp(prefix='toolsengine-upload-');self.addCleanup(lambda:__import__('shutil').rmtree(self.root))
        self.file=os.path.join(self.root,'resume.pdf');Path(self.file).write_text('fixture')
        self.dialog=Node('dialog','File Upload');self.gone=[False]
        for name,value in (('open_chooser',lambda:(self.dialog,77,'0x1')),('activate',lambda *a:'0x1'),
                           ('chooser_gone',lambda *a:self.gone[0]),('CLOSE_WAIT',0.1)):
            patcher=patch.object(adapter,name,value);patcher.start();self.addCleanup(patcher.stop)
    def entry(self,extra=''):
        field=Node('text','Location',text='',states=(S.ENABLED,S.FOCUSED));lagging(field,self.desktop,extra=extra)
        after_command(self.desktop,lambda c:c[-1] in (('key','Return'),('key','Escape')),lambda:self.gone.__setitem__(0,True))
        return field
    def test_path_is_entered_in_the_active_chooser_and_the_chooser_must_close(self):
        field=self.entry()
        with patch.object(adapter,'focused_text',return_value=field):
            self.assertIn('accepted "resume.pdf"',adapter.upload(self.file))
        self.assertEqual(self.desktop.commands,[('key','ctrl+l'),('key','ctrl+a'),('type',self.file),('key','Return')])
    def test_location_completion_is_removed_before_enter(self):
        field=self.entry(extra='.bak')
        with patch.object(adapter,'focused_text',return_value=field):adapter.upload(self.file)
        self.assertEqual(self.desktop.commands[-2:],[('key','Delete'),('key','Return')])
    def test_wrong_location_text_is_an_error_but_an_unclosed_chooser_after_enter_is_not(self):
        field=self.entry()
        with patch.object(adapter,'focused_text',return_value=field), patch.object(adapter,'confirm_text',return_value='/home/x'):
            with self.assertRaisesRegex(ValueError,'Enter was not pressed. The chooser is still open'):adapter.upload(self.file)
        self.assertNotIn(('key','Return'),self.desktop.commands)
        self.desktop.commands.clear();self.desktop.on_command=lambda argv:None;field.text=lambda:self.file
        with patch.object(adapter,'focused_text',return_value=field):
            result=adapter.dispatch({'op':'upload','path':self.file})
        self.assertRegex(result,'^Enter was pressed in the file chooser, but it is still open')
    def test_cancel_presses_escape_and_verifies_the_chooser_closed(self):
        self.entry()
        self.assertEqual(adapter.upload(None),'File chooser cancelled (verified closed).')
        self.assertEqual(self.desktop.commands,[('key','Escape')])
    def test_only_explicit_regular_visible_files_are_accepted(self):
        Path(self.root,'.ssh').mkdir();Path(self.root,'.ssh','id').write_text('secret')
        os.symlink(self.file,os.path.join(self.root,'link.pdf'))
        for bad in ('resume.pdf',os.path.join(self.root,'.ssh','id'),os.path.join(self.root,'link.pdf'),self.root,
                    self.root+'/x/../resume.pdf',self.file+'\n'):
            with self.assertRaises((ValueError,OSError)):adapter.upload(bad)
        self.assertEqual(self.desktop.commands,[])
    def test_no_chooser_is_reported_and_hidden_portal_frames_do_not_collide(self):
        hidden=Node('frame','Portal');dialog=Node('dialog','File Upload')
        with patch.object(adapter,'choosers',return_value=[(hidden,77),(dialog,77)]), patch.object(adapter,'x_windows',return_value=[('0x1','File Upload')]):
            self.assertEqual(REAL_OPEN_CHOOSER(),(dialog,77,'0x1'))
        with patch.object(adapter,'choosers',return_value=[]), patch.object(adapter,'CHOOSER_WAIT',0.05):
            with self.assertRaisesRegex(ValueError,'No file chooser is open'):REAL_OPEN_CHOOSER()

class HiddenDisplayRaceTests(unittest.TestCase):
    # Two helpers (two agents' hidden Firefoxes) can pick the same free display
    # number at once. Only the Xvfb named in the display's lock owns it; the
    # helper whose Xvfb lost moves on to the next number.
    def setUp(self):
        self.profile=tempfile.mkdtemp()
        self.addCleanup(__import__('shutil').rmtree,self.profile,True)
        self.sockets,self.locks,self.started=set(),{},[]
        real=os.path.exists
        def exists(path):
            path=str(path)
            if path.startswith('/tmp/.X11-unix/X'):return int(path[16:]) in self.sockets
            if path.startswith('/tmp/.X') and path.endswith('-lock'):return int(path[7:-5]) in self.locks
            return real(path)
        test=self
        class Xvfb:
            def __init__(self,argv,**kw):
                self.number=int(argv[1][1:]);self.pid=1000+len(test.started);self.polls=0
                test.started.append(self)
                if self.number==97:
                    # The other helper's Xvfb won :97 a moment earlier; this one is refused.
                    test.sockets.add(97);test.locks[97]=4242
                else:
                    test.sockets.add(self.number);test.locks[self.number]=self.pid
            def poll(self):
                self.polls+=1
                return 1 if self.number==97 and self.polls>3 else None
            def terminate(self):pass
            def wait(self,timeout=None):return 0
        for item in (patch.object(adapter,'AGENT_MODE',True),patch.object(adapter,'AGENT_PROFILE',self.profile),
                     patch.object(adapter,'VISIBLE_DISPLAY',':0'),patch.object(adapter,'_agent_display_ready',False),
                     patch.object(adapter.shutil,'which',lambda name:'/usr/bin/'+name),
                     patch.object(adapter.subprocess,'run',return_value=None),patch.object(adapter.subprocess,'Popen',Xvfb),
                     patch.object(adapter.os.path,'exists',exists),patch.object(adapter,'process_birth',lambda pid:'1'),
                     patch.object(adapter,'display_lock_pid',lambda number:self.locks.get(number)),
                     patch.object(adapter.time,'sleep',lambda s:None),
                     patch.dict(os.environ,{'DISPLAY':':0'})):
            item.start();self.addCleanup(item.stop)
    def test_a_display_whose_lock_names_another_xvfb_is_not_taken(self):
        self.assertEqual(adapter.ensure_agent_display(),':96')
        self.assertEqual([x.number for x in self.started],[97,96])
        receipt=json.loads(Path(self.profile,'.toolsengine-display.json').read_text())
        self.assertEqual((receipt['display'],receipt['pid']),(':96',self.started[1].pid))
        self.assertEqual(os.environ['DISPLAY'],':96')

class HiddenDisplayForShowTests(unittest.TestCase):
    # browser.show asks the helper which display to show. Only the agent
    # profile's own attested display, with its private cookie file, is named.
    def setUp(self):
        self.profile=tempfile.mkdtemp()
        self.auth=os.path.join(self.profile,'.toolsengine-xauthority-0123456789abcdef')
        fd=os.open(self.auth,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
        self.patches=[patch.object(adapter,'AGENT_MODE',True),patch.object(adapter,'AGENT_PROFILE',self.profile),
                      patch.object(adapter,'VISIBLE_DISPLAY',':0'),patch.object(adapter,'ensure_agent_display',lambda:':90'),
                      patch.dict(os.environ,{'DISPLAY':':90','XAUTHORITY':self.auth})]
        for item in self.patches:item.start()
    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        import shutil;shutil.rmtree(self.profile,ignore_errors=True)
    def request(self):
        return adapter.dispatch({'op':'display','sessionTarget':'hidden-window','display':':90','profile':self.profile})
    def test_the_agent_display_and_its_cookie_file_are_named(self):
        self.assertEqual(self.request(),{'display':':90','xauthority':self.auth})
    def test_the_visible_display_another_cookie_or_an_open_cookie_file_are_refused(self):
        with patch.dict(os.environ,{'DISPLAY':':0'}):
            with self.assertRaisesRegex(ValueError,'visible display|could not be identified'):self.request()
        other=os.path.join(tempfile.mkdtemp(),'.toolsengine-xauthority-0123456789abcdef')
        fd=os.open(other,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
        with patch.dict(os.environ,{'XAUTHORITY':other}):
            with self.assertRaisesRegex(ValueError,'could not be identified'):self.request()
        os.chmod(self.auth,0o644)
        with self.assertRaisesRegex(ValueError,'could not be identified'):self.request()
    def test_outside_agent_mode_no_display_is_offered(self):
        with patch.object(adapter,'AGENT_MODE',False):
            with self.assertRaisesRegex(ValueError,'Only the hidden Firefox display'):adapter.dispatch({'op':'display'})

unittest.main()
