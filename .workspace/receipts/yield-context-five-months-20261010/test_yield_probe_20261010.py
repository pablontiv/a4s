import unittest, tempfile, json
from pathlib import Path
from datetime import timedelta
from unittest.mock import patch
import yield_probe_20261010 as p

class ProbeTests(unittest.TestCase):
 def setUp(self):
  p.TURNS.clear();p.STREAMS.clear();p.EDITS.clear();p.SEEN.clear();p.CLAUDE_OWNER.clear();p.EXCLUDED_FIXTURES.clear();p.STATS.clear();p.REP_CACHE.clear();p.DIR_CACHE.clear();p.REPOS.clear()
 def test_zero_sample_formats_as_unavailable(self):
  self.assertEqual(p.format_pct(None),'N/A');self.assertEqual(p.format_pct(0),'0.000%')
 def test_legacy_json_string_edits_are_normalized(self):
  r=p.extract_edits('edit',{'path':'x.py','edits':'[{"oldText":"old","newText":"new"}]'},'/tmp')
  self.assertEqual(r,[('/tmp/x.py',['new'],3)])
 def test_malformed_edits_do_not_crash_or_invent_changes(self):
  self.assertEqual(p.extract_edits('edit',{'path':'x.py','edits':'[{broken]'},'/tmp'),[])
 def test_unobservable_directory_is_not_reprobed_per_file(self):
  with tempfile.TemporaryDirectory()as d:
   with patch.object(p,'git',return_value=None)as probe:
    self.assertIsNone(p.repo_for(str(Path(d)/'one.py')))
    self.assertIsNone(p.repo_for(str(Path(d)/'two.py')))
   self.assertEqual(probe.call_count,1)
 def test_edit_counts_added_lines_not_context(self):
  self.assertEqual(p.changed_lines('stable\nold\n','stable\nnew\n'),['new'])
 def test_patch_does_not_credit_removed_lines(self):
  self.assertEqual(p.parse_patch('*** Begin Patch\n*** Update File: x.py\n context\n-old\n+new\n*** End Patch'),[('x.py',['new'])])
 def test_date_window_is_half_open(self):
  self.assertTrue(p.inrange(p.START));self.assertFalse(p.inrange(p.END))
 def test_cached_codex_input_is_not_added_twice(self):
  s={'key':'s','turns':[]}
  t=p.newturn(s,p.START,'m',{'input_tokens':100,'cached_input_tokens':80},'codex')
  self.assertEqual(t['context'],100)
 def test_pi_context_includes_cache(self):
  s={'key':'s','turns':[]}
  self.assertEqual(p.newturn(s,p.START,'m',{'input':10,'cacheRead':80,'cacheWrite':10},'pi')['context'],100)
 def test_failed_write_is_not_success(self):
  s={'key':'s','cwd':'/tmp','turns':[],'calls':p.defaultdict(list)}
  t=p.newturn(s,p.START,'m',{},'pi')
  p.addcall(t,s,'write',{'path':'x','content':'long unique line in x'},'a');p.statuscall(s,'a',True)
  self.assertEqual(p.EDITS[0]['status'],'failed')
 def rows(self):
  return [{'time':p.START+timedelta(minutes=i),'timestamp':'t','index':i,'model':'m','harness':'pi','segment':0,'context':10000+i*1000,'output_chars':1000,'retained_chars':100 if i<10 else 0,'success_calls':1,'observable_success_calls':1,'successful_write_chars':1000,'observable_write_chars':1000} for i in range(35)]
 def test_productive_decline_detected(self):self.assertIsNotNone(p.detect(self.rows()))
 def test_exploration_not_detected(self):
  rs=self.rows()
  for r in rs[10:]:r['success_calls']=0;r['observable_success_calls']=0
  self.assertIsNone(p.detect(rs))
 def test_missing_git_does_not_trigger_decline(self):
  rs=self.rows()
  for r in rs[10:]:r['observable_success_calls']=0;r['observable_write_chars']=0
  self.assertIsNone(p.detect(rs))
 def test_compaction_resets_baseline(self):
  rs=self.rows()
  for r in rs[10:]:r['segment']=1
  self.assertIsNone(p.detect(rs))
 def test_repeated_snapshot_lines_do_not_exceed_emitted_lines(self):
  text='a deliberately distinctive repeated line'
  s={'key':'s','cwd':'/tmp','turns':[],'calls':p.defaultdict(list)}
  t=p.newturn(s,p.START,'m',{},'pi')
  p.addcall(t,s,'write',{'path':'/tmp/x','content':text},'a');p.statuscall(s,'a',False)
  p.REPOS['repo']={'ref':'main','root':'/tmp','sha':'f'*40,'tip_time':int(p.END.timestamp())}
  blame=''
  for i in [1,2]:blame+='a'*40+f' {i} {i} 1\ncommitter-time '+str(int((p.START+timedelta(hours=1)).timestamp()))+'\n\t'+text+'\n'
  with patch.object(p,'repo_for',return_value={'repo':'repo','root':'/tmp','inferred':False}),patch.object(p,'git',return_value=blame):p.match_git()
  self.assertEqual(t['retained_chars'],len(text))
 def test_claude_copied_response_counted_once(self):
  with tempfile.TemporaryDirectory()as d:
   rec={'type':'assistant','timestamp':p.START.isoformat(),'sessionId':'a','message':{'id':'same-response','model':'claude','role':'assistant','content':[{'type':'text','text':'real output'}],'usage':{'input_tokens':100,'output_tokens':2}}}
   for name in ['a.jsonl','b.jsonl']:
    f=Path(d)/name;f.write_text(json.dumps(rec)+'\n');p.parse_source('claude',f)
  self.assertEqual(len(p.TURNS),1)
 def test_verified_faux_fixture_is_excluded(self):
  with tempfile.TemporaryDirectory()as d:
   f=Path(d)/'s.jsonl';f.write_text(json.dumps({'type':'message','id':'mock','timestamp':p.START.isoformat(),'message':{'model':'faux-1','provider':'faux','role':'assistant','content':[{'type':'text','text':'mock output'}],'usage':{'input':100,'output':2}}})+'\n')
   p.parse_source('pi',f)
  self.assertEqual(len(p.TURNS),0)
 def test_claude_synthetic_not_counted(self):
  with tempfile.TemporaryDirectory()as d:
   f=Path(d)/'s.jsonl';f.write_text(json.dumps({'type':'assistant','timestamp':p.START.isoformat(),'message':{'id':'synthetic','model':'<synthetic>','role':'assistant','content':[{'type':'text','text':'system message'}],'usage':{}}})+'\n')
   p.parse_source('claude',f)
  self.assertEqual(len(p.TURNS),0)

if __name__=='__main__':unittest.main(verbosity=2)
