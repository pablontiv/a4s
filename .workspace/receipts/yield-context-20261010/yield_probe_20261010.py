#!/usr/bin/env python3
"""Disposable retrospective probe. Not a replacement for cost-analyzer."""
import json, sys, os, re, hashlib, subprocess, difflib, csv, math, html
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timedelta, timezone
from statistics import median
sys.path.insert(0, '/Users/Shared/harness/a4s/skills/cost-analyzer/assets')
import dataset
END=datetime.fromisoformat('2026-10-11T01:42:10+00:00'); START=END-timedelta(days=21)
OUT=Path('/Users/Shared/harness/a4s/.workspace/receipts/yield-context-20261010')
EXCLUDE='01a1289d-1049-7582-83b9-2282d4cd4de8'
STATS=Counter(); TURNS=[]; STREAMS=[]; EDITS=[]; SEEN=set(); CLAUDE_OWNER={}; EXCLUDED_FIXTURES=set(); REP_CACHE={}; REPOS={}

def ts(v):
    if isinstance(v,(int,float)):
        try:return datetime.fromtimestamp(v/1000 if v>1e11 else v,timezone.utc)
        except (ValueError,OverflowError):return None
    try:return datetime.fromisoformat(v.replace('Z','+00:00')) if isinstance(v,str) else None
    except ValueError:return None

def inrange(t): return t is not None and START<=t<END

def stable(v):return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(v):return hashlib.sha256(stable(v).encode()).hexdigest()
def git(cwd,*args):
    try:
        p=subprocess.run(['git','-C',str(cwd),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        return p.stdout.decode('utf-8',errors='replace') if p.returncode==0 else None
    except (OSError,subprocess.TimeoutExpired):return None

def repo_for(path):
    key=str(path)
    if key in REP_CACHE:return REP_CACHE[key]
    p=Path(key).expanduser(); inferred=False
    if not p.is_dir(): p=p.parent
    while not p.exists() and p!=p.parent:p=p.parent;inferred=True
    root=git(p,'rev-parse','--show-toplevel')
    if not root:REP_CACHE[key]=None;return None
    root=root.strip(); common=git(root,'rev-parse','--path-format=absolute','--git-common-dir')
    if not common:REP_CACHE[key]=None;return None
    common=common.strip()
    if common not in REPOS:
        refs=[]
        origin=git(root,'symbolic-ref','--short','refs/remotes/origin/HEAD')
        for ref in ([origin.strip()] if origin else [])+['main','origin/main','master','origin/master']:
            sha=git(root,'rev-parse','--verify',ref+'^{commit}')
            if sha:
                ct=git(root,'show','-s','--format=%ct',sha.strip())
                refs.append((int(ct.strip()) if ct else 0,ref,sha.strip()))
        # Compare local and tracking refs only for the same default branch.
        default=(origin.strip().removeprefix('origin/') if origin else next((x for x in ['main','master'] if any(y[1] in [x,'origin/'+x] for y in refs)),None))
        eligible=[x for x in refs if x[1] in [default,'origin/'+str(default)]]
        tip=max(eligible,default=(0,None,None))
        REPOS[common]={'root':root,'common':common,'ref':tip[1],'sha':tip[2],'tip_time':tip[0],'default_branch':default}
    result={'repo':common,'root':root,'inferred':inferred};REP_CACHE[key]=result;return result

def changed_lines(old,new):
    a=old.splitlines();b=new.splitlines()
    lines=[]
    for op,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
        if op in ['insert','replace']:lines.extend(b[k:l])
    return lines

def parse_patch(s):
    results=[];path=None;lines=[]
    for line in s.splitlines():
        if line.startswith(('*** Add File: ','*** Update File: ')):
            if path:results.append((path,lines))
            path=line.split(': ',1)[1];lines=[]
        elif line.startswith('*** Move to: '):path=line.split(': ',1)[1]
        elif line.startswith('*** Delete File: '):
            if path:results.append((path,lines))
            path=None;lines=[]
        elif path and line.startswith('+'):lines.append(line[1:])
    if path:results.append((path,lines))
    return results

def extract_edits(name,args,cwd):
    out=[];name=name.rsplit('__',1)[-1].lower()
    if name in ['write','edit'] and isinstance(args,dict):
        path=args.get('path',args.get('file_path'))
        if not path:return []
        if name=='write':
            s=args.get('content','');out=[(path,s.splitlines(),len(s))]
        else:
            chunks=args.get('edits') or [args]
            for chunk in chunks:
                old=chunk.get('oldText',chunk.get('old_string',chunk.get('old_text')))
                new=chunk.get('newText',chunk.get('new_string',chunk.get('new_text')))
                if isinstance(new,str):out.append((path,changed_lines(old,new) if isinstance(old,str) else new.splitlines(),len(new)))
                else:STATS['unparsed_edit_hunks']+=1
    elif name=='apply_patch' and isinstance(args,str):out=[(p,ls,sum(len(x)+1 for x in ls)) for p,ls in parse_patch(args)]
    elif name=='exec' and isinstance(args,str):
        # Literal JSON JS strings only. Never execute source or infer arbitrary shell writes.
        for match in re.finditer(r'apply_patch\(\s*("(?:\\.|[^"\\])*")\s*\)',args):
            try:patch=json.loads(match.group(1))
            except ValueError:continue
            out.extend((p,ls,sum(len(x)+1 for x in ls)) for p,ls in parse_patch(patch))
    return [(str(Path(p).expanduser() if os.path.isabs(p) else Path(cwd or '/UNKNOWN')/p),ls,n) for p,ls,n in out]

def newturn(stream,t,model,u,h,chars=0,blocks=None,mid=None):
    if h=='pi':
        context=sum(u.get(k,0) or 0 for k in ['input','cacheRead','cacheWrite']);output=u.get('output',0)or 0
    elif h=='claude':
        context=sum(u.get(k,0)or 0 for k in ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens']);output=u.get('output_tokens',0)or 0
    else:
        context=u.get('input_tokens',0)or 0;output=u.get('output_tokens',0)or 0
    row={'index':len(TURNS),'stream':stream['key'],'harness':h,'model':model or 'unknown','timestamp':t.isoformat(),'time':t,'context':context or None,'output_tokens':output,'output_chars':chars,'retained_chars':0,'mature_chars':0,'ambiguous_chars':0,'structured_write_chars':0,'successful_write_chars':0,'write_calls':0,'success_calls':0,'observable_success_calls':0,'observable_write_chars':0,'unknown_mutation_calls':0,'segment':stream.get('segment',0),'mid':mid,'blocks':set(blocks or [])}
    TURNS.append(row);stream['turns'].append(row);return row

def addcall(turn,stream,name,args,callid):
    mutations=extract_edits(name,args,stream['cwd'])
    if re.search(r'(?:cat\s+[^\n]*>|<<\s*[\'\"]?\w+|\.write_text\(|writeFile|sed\s+-i|apply_patch|python[^\n]*open\()',str(args)) and not mutations:
        turn['unknown_mutation_calls']+=1
    if not mutations:return
    turn['write_calls']+=1
    for path,lines,n in mutations:
        e={'turn':turn['index'],'stream':stream['key'],'path':os.path.normpath(path),'lines':lines,'emitted_chars':n,'time':turn['time'],'callid':callid,'status':'unknown','tool':name}
        turn['structured_write_chars']+=n;EDITS.append(e);stream['calls'][callid].append(e)

def statuscall(stream,callid,error):
    for e in stream['calls'].get(callid,[]):e['status']='failed' if error else 'success'

def parse_source(h,path):
    stream={'key':h+':'+str(path),'source':str(path),'harness':h,'id':None,'cwd':None,'turns':[],'calls':defaultdict(list),'segment':0,'parent':None}
    ctypes=Counter();spawn=intercom=assistant_all=0;delegation=False;cross=False;crossflag=False
    model=None;pending=[];codexmodern=False;lastcodex=None;seen_resp=set();claude_turns={};seenpi=set();results={}
    # Cheap first pass for Codex inference usage format.
    if h=='codex':
        with path.open(errors='replace') as f:codexmodern=any('"type": "token_usage_record"' in l or '"type":"token_usage_record"' in l for l in f)
    with path.open(errors='replace') as f:
      for line in f:
        try:o=json.loads(line)
        except (ValueError,UnicodeError):STATS['invalid_json_lines']+=1;continue
        kind=o.get('type');m=o.get('message') or {};q=o.get('payload')or{}
        t=ts(o.get('timestamp'))
        if not isinstance(m,dict):m={}
        if not isinstance(q,dict):q={}
        if h=='pi':
            if kind=='session':stream['id']=o.get('id');stream['cwd']=o.get('cwd');cross=bool(o.get('parent_session_id'));stream['parent']=o.get('parent_session_id')
            if kind=='model_change':model=o.get('modelId') or model
            if kind=='compaction':stream['segment']+=1
            if kind in ['custom','custom_message']:
                ctypes[o.get('customType','')]+=1
                if dataset.detect_cross_session_signal([o]):cross=True
            spawn+=dataset.legacy_spawn_count(o);intercom+=dataset.intercom_toolcall_count(o)
            if kind=='message' and m.get('role')=='assistant':
                assistant_all+=1
                if not inrange(t):continue
                if m.get('model')in ['faux-1','faux-2']:
                    STATS['excluded_verified_fixture_steps']+=1;EXCLUDED_FIXTURES.add(str(path));continue
                content=m.get('content')or[]
                marker=(h,o.get('id'),o.get('timestamp'),digest(content))
                if marker in SEEN:STATS['duplicate_assistant_records']+=1;continue
                SEEN.add(marker)
                chars=0
                for b in content:
                    if b.get('type') in ['text','thinking']:chars+=len(b.get('text',b.get('thinking','')))
                    elif b.get('type')=='toolCall':chars+=len(stable(b.get('arguments')or{}))
                turn=newturn(stream,t,m.get('model')or model,m.get('usage')or{},h,chars)
                for b in content:
                    if b.get('type')=='toolCall':addcall(turn,stream,b.get('name',''),b.get('arguments')or{},b.get('id'))
            if kind=='message' and m.get('role')=='toolResult':statuscall(stream,m.get('toolCallId'),bool(m.get('isError')))
        elif h=='claude':
            stream['id']=stream['id'] or o.get('sessionId');stream['cwd']=o.get('cwd')or stream['cwd']
            if kind=='system' and o.get('subtype')=='compact_boundary':stream['segment']+=1
            if kind=='assistant':
                if m.get('model')=='<synthetic>':STATS['excluded_synthetic_responses']+=1;continue
                model=m.get('model')or model
                content=m.get('content')or[]
                delegation=delegation or any(isinstance(b,dict)and b.get('name')=='Agent' for b in content)
                if not inrange(t):continue
                mid=m.get('id')or o.get('uuid');u=m.get('usage')or{}
                if mid not in claude_turns:
                    if mid in CLAUDE_OWNER:claude_turns[mid]=CLAUDE_OWNER[mid][0];STATS['copied_claude_responses']+=1
                    else:
                        claude_turns[mid]=newturn(stream,t,model,u,h,mid=mid);CLAUDE_OWNER[mid]=(claude_turns[mid],stream)
                turn=claude_turns[mid];turn['context']=max(turn['context']or 0,sum(u.get(k,0)or 0 for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens'])) or None
                turn['output_tokens']=max(turn['output_tokens'],u.get('output_tokens',0)or 0)
                for b in content:
                    if not isinstance(b,dict):continue
                    mark=(h,mid,digest(b))
                    if mark in SEEN:STATS['duplicate_assistant_blocks']+=1;continue
                    SEEN.add(mark)
                    if b.get('type')in ['text','thinking']:turn['output_chars']+=len(b.get('text',b.get('thinking','')))
                    elif b.get('type')=='tool_use':
                        args=b.get('input')or{};turn['output_chars']+=len(stable(args));addcall(turn,CLAUDE_OWNER[mid][1],b.get('name',''),args,b.get('id'))
            if kind=='user':
                for b in m.get('content')or[]:
                    if isinstance(b,dict)and b.get('type')=='tool_result':statuscall(stream,b.get('tool_use_id'),bool(b.get('is_error')))
        else:
            if kind=='session_meta':stream['id']=q.get('id',q.get('session_id'));stream['cwd']=q.get('cwd');model=q.get('model')or model
            if kind=='turn_context':stream['cwd']=q.get('cwd')or stream['cwd'];model=q.get('model')or model
            if kind=='compacted':stream['segment']+=1
            if kind=='response_item':
                qt=q.get('type');delegation=delegation or q.get('name')in ['spawn_agent','followup_task']
                if qt in ['function_call_output','custom_tool_call_output']:
                    # Exit-code or explicit error only; absence is unknown, never success.
                    s=str(q.get('output',''));cid=q.get('call_id')
                    fail='isError\": true' in s or bool(re.search(r'Process exited with code [1-9]',s))
                    success=bool(re.search(r'(?:exit_code[\'\"]?\s*:\s*0|Process exited with code 0|Success\. Updated the following files)',s))
                    if fail or success:statuscall(stream,cid,fail)
                if not inrange(t):continue
                if qt in ['function_call','custom_tool_call','reasoning']or(qt=='message' and q.get('role')=='assistant'):
                    mark=(h,q.get('id'),digest(q),o.get('timestamp'))
                    if mark in SEEN:STATS['duplicate_assistant_records']+=1;continue
                    SEEN.add(mark);pending.append((t,q))
            if kind=='token_usage_record' or (not codexmodern and kind=='event_msg'and q.get('type')=='token_count'):
                u=q.get('usage')or{} if codexmodern else (q.get('info')or{}).get('last_token_usage')or{}
                rid=q.get('response_id') if codexmodern else digest([o.get('timestamp'),u])
                if rid in seen_resp:continue
                seen_resp.add(rid)
                if not inrange(t):pending=[];continue
                turn=newturn(stream,t,model,u,h)
                for pt,b in pending:
                    if b.get('type')=='message':turn['output_chars']+=sum(len(x.get('text','')) for x in b.get('content')or[] if isinstance(x,dict))
                    elif b.get('type')=='reasoning':
                        turn['output_chars']+=sum(len(x.get('text','')) for x in (b.get('summary')or[])+(b.get('content')or[])if isinstance(x,dict))
                        if b.get('encrypted_content'):STATS['encrypted_reasoning_items']+=1
                    else:
                        args=b.get('arguments',b.get('input',''));turn['output_chars']+=len(args)if isinstance(args,str)else len(stable(args))
                        if b.get('type')=='function_call':
                            try:args=json.loads(args)
                            except (TypeError,ValueError):pass
                        addcall(turn,stream,b.get('name',''),args,b.get('call_id'))
                pending=[]
    if h=='pi':
        form=dataset.classify_pi_form(ctypes['subagent-notify']>0 or spawn>0,dataset.calculate_delegation_degree(spawn,assistant_all),cross)
        stream['degree']=dataset.calculate_delegation_degree(spawn,assistant_all)
        stream['legacy']=dataset.classify_pi_topology(ctypes,spawn,intercom)
        stream['confidence']='inferred' if cross or form=='form-solo' else 'direct'
    else:
        form=dataset.classify_non_pi_form(delegation);stream['degree']=None;stream['legacy']='S2'if delegation else 'S1';stream['confidence']='direct'if delegation else 'inferred'
    stream['form']=form
    if h=='claude' and 'subagents' in path.parts:stream['parent']=path.parent.parent.name
    if stream['turns']:
        STREAMS.append(stream)
        for turn in stream['turns']:turn['form']=form;turn['confidence']=stream['confidence']
    return stream

def discover():
    for h,root in dataset.DEFAULT_ROOTS.items():
        for path in sorted(root.rglob('*.jsonl')):
            if EXCLUDE in str(path):STATS['excluded_current_stream']+=1;continue
            # Canonical mtime pre-selection preserved; events then restricted to rolling window.
            if path.stat().st_mtime<START.timestamp():continue
            STATS[h+'_candidate_files']+=1
            parse_source(h,path)
    STATS['excluded_verified_fixture_streams']=len(EXCLUDED_FIXTURES)
    # Ensure failed/unknown calls are not numerator candidates.
    successes=set()
    for e in EDITS:
        if e['status']=='success':
            TURNS[e['turn']]['successful_write_chars']+=e['emitted_chars'];successes.add((e['turn'],e['callid']))
        STATS['edit_'+e['status']]+=1
    for i,cid in successes:TURNS[i]['success_calls']+=1
    print('Normalized:',len(STREAMS),'streams',len(TURNS),'inference steps',len(EDITS),'structured edits',flush=True)

def match_git():
    buckets=defaultdict(list)
    for e in EDITS:
        if e['status']!='success':continue
        r=repo_for(e['path'])
        if not r:STATS['edits_without_git']+=1;continue
        e['repo']=r['repo'];e['repo_inferred']=r['inferred']
        try:rel=str(Path(e['path']).relative_to(r['root']))
        except ValueError:STATS['edits_unresolved_relpath']+=1;continue
        e['relpath']=rel;buckets[(r['repo'],rel)].append(e)
    evidence=[]; consumed=Counter()
    for n,((common,path),edits)in enumerate(buckets.items()):
        repo=REPOS[common]
        if not repo['ref']:STATS['files_without_default_ref']+=1;continue
        output=git(repo['root'],'blame','--line-porcelain',repo['sha'],'--',path)
        if output is None:STATS['files_absent_or_blame_failed']+=1;continue
        STATS['files_blame_read']+=1
        for e in edits:
            e['blame_observable']=True
            e['snapshot_covers_write']=repo['tip_time']>=e['time'].timestamp()
        index=defaultdict(list)
        for e in edits:
            for line in set(e['lines']):
                if len(line.strip())>=16:index[line].append(e)
        sha=None;committime=None;lineno=None
        for line in output.splitlines():
            match=re.match(r'^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$',line)
            if match:sha=match.group(1);lineno=int(match.group(2));committime=None
            elif line.startswith('committer-time '):committime=datetime.fromtimestamp(int(line.split()[1]),timezone.utc)
            elif line.startswith('\t')and committime:
                text=line[1:]
                if not START<=committime<END:continue
                eligible=[e for e in index.get(text,[])if e['time']<=committime and consumed[(id(e),text)]<e['lines'].count(text)]
                if not eligible:continue
                owners={e['stream']for e in eligible};size=len(text)
                if len(owners)==1:
                    e=max(eligible,key=lambda e:e['time']);consumed[(id(e),text)]+=1;t=TURNS[e['turn']]
                    t['retained_chars']+=size
                    mature=(END-committime).total_seconds()>=7*86400
                    if mature:t['mature_chars']+=size
                    status='single-source-exact-match'
                else:
                    for owner in owners:
                        picked=max((e for e in eligible if e['stream']==owner),key=lambda e:e['time']);consumed[(id(picked),text)]+=1
                    e=None;mature=(END-committime).total_seconds()>=7*86400;status='ambiguous-multiple-streams';STATS['ambiguous_retained_chars']+=size
                evidence.append({'repo':common,'ref':repo['ref'],'snapshot_sha':repo['sha'],'file':path,'line':lineno,'origin_sha':sha,'commit_time':committime.isoformat(),'characters':size,'mature_7d':mature,'attribution':status,'candidate_streams':len(owners),'turn':e['turn']if e else None,'content_sha256':hashlib.sha256(text.encode()).hexdigest()})
        if n%100==0:print('Blame:',n+1,'/',len(buckets),flush=True)
    observable=set()
    for e in EDITS:
        if e.get('blame_observable') and e.get('snapshot_covers_write'):
            TURNS[e['turn']]['observable_write_chars']+=e['emitted_chars'];observable.add((e['turn'],e['callid']))
    for i,cid in observable:TURNS[i]['observable_success_calls']+=1
    STATS['edits_with_blame_observable']=sum(bool(e.get('blame_observable'))for e in EDITS)
    STATS['edits_with_snapshot_covering_write']=sum(bool(e.get('blame_observable')and e.get('snapshot_covers_write'))for e in EDITS)
    print('Git matched:',len(evidence),'lines',flush=True);return evidence

def detect(rows,window=10,consecutive=3,threshold=1/3):
    """Chars persisted / observable output chars in a 10-inference window.
    Baseline is first productive window with >=3 successful mutation steps.
    Require productive recent windows too; do not interpret exploration-only zeros.
    Reset at recorded compaction and model changes.
    """
    rows=sorted(rows,key=lambda t:t['time']);baseline=None;run=0;hit=None
    for i in range(window-1,len(rows)):
        w=rows[i-window+1:i+1]
        if len({(r['model'],r['segment'])for r in w})!=1:baseline=None;run=0;continue
        output=sum(r['output_chars']for r in w);value=sum(r['retained_chars']for r in w)
        productive=sum(r['observable_success_calls']>0 for r in w)
        written=sum(r['successful_write_chars']for r in w)
        covered=sum(r['observable_write_chars']for r in w)
        if output<=0 or productive<3 or written<=0 or covered/written<0.8:run=0;continue
        rate=value/output
        if baseline is None:
            if value>=100:baseline=rate
            continue
        if rate<baseline*threshold:run+=1
        else:run=0
        if run>=consecutive and all(r['context']is not None for r in w):
            hit={'context':rows[i]['context'],'index':rows[i]['index'],'baseline':baseline,'window_yield':rate,'model':rows[i]['model'],'harness':rows[i]['harness'],'timestamp':rows[i]['timestamp']};break
    return hit

def format_pct(value):return 'N/A'if value is None else f'{value:.3f}%'

def writecsv(name,rows,fields):
    with (OUT/name).open('w')as f:
        w=csv.DictWriter(f,fields,extrasaction='ignore');w.writeheader();w.writerows(rows)

def report(evidence):
    groups=defaultdict(list);sessionrows=[];hits=[];sens=defaultdict(list)
    for s in STREAMS:
        rows=s['turns'];chars=sum(t['output_chars']for t in rows);retained=sum(t['retained_chars']for t in rows)
        r={k:s.get(k)for k in ['key','source','id','cwd','harness','form','legacy','confidence','degree','parent']}
        r.update({'inference_steps':len(rows),'output_chars':chars,'retained_chars':retained,'mature_chars':sum(t['mature_chars']for t in rows),'write_chars':sum(t['structured_write_chars']for t in rows),'yield':retained/chars if chars else None,'observable_write_chars':sum(t['observable_write_chars']for t in rows),'successful_write_chars':sum(t['successful_write_chars']for t in rows),'unknown_mutation_calls':sum(t['unknown_mutation_calls']for t in rows),'models':','.join(sorted({t['model']for t in rows}))})
        sessionrows.append(r)
        # Coordinators need child attribution to make per-stream decline meaningful.
        if s['form']=='form-solo':
            hit=detect(rows)
            if hit:hit['stream']=s['key'];hits.append(hit)
            for w in [5,10,20]:
                v=detect(rows,window=w)
                if v:sens[w].append(v)
        groups[(s['harness'],s['form'])].append(r)
    aggregate=[]
    for h in ['pi','claude','codex']:
        for form in (list(dataset.FORM_LABELS) if h=='pi' else ['form-solo','form-orch-hybrid']):groups[(h,form)]
    for (h,form),rows in sorted(groups.items()):
        v={k:sum(r[k]for r in rows)for k in ['inference_steps','output_chars','retained_chars','mature_chars','write_chars']}
        v.update({'harness':h,'form':form,'streams':len(rows),'yield_pct':100*v['retained_chars']/v['output_chars']if v['output_chars']else None});aggregate.append(v)
    byid={r['id']:r for r in sessionrows if r['harness']=='claude'and not r['parent']}
    families=defaultdict(list)
    for r in sessionrows:
        parent=byid.get(r['parent']) if r['harness']=='claude'and r['parent'] else None
        root=parent or r
        families[root['key']].append(r)
        for hit in hits:
            if hit.get('stream')==r['key']:hit['family']=root['key'];hit['role']='child'if parent else 'root'
    familyrows=[]
    for key,members in families.items():
        root=next((r for r in members if r['key']==key),members[0])
        v={k:sum(r[k]for r in members)for k in ['inference_steps','output_chars','retained_chars','mature_chars','write_chars','observable_write_chars','successful_write_chars']}
        v.update({'family':key,'harness':root['harness'],'form':root['form'],'member_streams':len(members),'yield_pct':100*v['retained_chars']/v['output_chars']if v['output_chars']else None,'linkage':'explicit-Claude-subagent-path'if len(members)>1 else 'single-observed-stream; cross-session linkage incomplete'})
        familyrows.append(v)
    writecsv('families.csv',familyrows,list(familyrows[0])if familyrows else ['family'])
    legacygroups=defaultdict(list)
    for r in sessionrows:legacygroups[(r['harness'],r['legacy'])].append(r)
    legacyaggregate=[]
    for (h,legacy),rs in sorted(legacygroups.items()):
        v={k:sum(r[k]for r in rs)for k in ['inference_steps','output_chars','retained_chars','mature_chars']}
        v.update({'harness':h,'legacy':legacy,'streams':len(rs),'yield_pct':100*v['retained_chars']/v['output_chars']if v['output_chars']else None});legacyaggregate.append(v)
    writecsv('legacy-scenarios.csv',legacyaggregate,list(legacyaggregate[0])if legacyaggregate else ['harness'])
    writecsv('excluded-fixtures.csv',[{'source':p,'reason':'Verified Pi faux-1/faux-2 test provider; not operational model output'}for p in sorted(EXCLUDED_FIXTURES)],['source','reason'])
    writecsv('streams.csv',sessionrows,list(sessionrows[0])if sessionrows else ['source'])
    writecsv('turns.csv',TURNS,['index','stream','harness','model','form','confidence','timestamp','segment','context','output_tokens','output_chars','structured_write_chars','successful_write_chars','write_calls','success_calls','observable_success_calls','observable_write_chars','unknown_mutation_calls','retained_chars','mature_chars'])
    writecsv('line-evidence.csv',evidence,list(evidence[0])if evidence else ['repo'])
    writecsv('candidates.csv',hits,['stream','family','role','harness','model','context','index','timestamp','baseline','window_yield'])
    writecsv('aggregate.csv',aggregate,list(aggregate[0])if aggregate else ['harness'])
    modelgroups=defaultdict(list)
    for t in TURNS:modelgroups[(t['harness'],t['model'])].append(t)
    models=[]
    for (h,m),rs in sorted(modelgroups.items()):
        valid=[t['context']for t in rs if t['context']]
        cs=[hit['context']for hit in hits if (hit['harness'],hit['model'])==(h,m)]
        independent={hit['family']for hit in hits if (hit['harness'],hit['model'])==(h,m)}
        models.append({'harness':h,'model':m,'steps':len(rs),'context_observed_steps':len(valid),'median_context':median(valid)if valid else None,'output_chars':sum(t['output_chars']for t in rs),'retained_chars':sum(t['retained_chars']for t in rs),'candidate_streams':len(cs),'independent_candidate_families':len(independent),'median_candidate_context':median(cs)if len(independent)>=5 else None})
    writecsv('models.csv',models,list(models[0])if models else ['harness'])
    summary={'start_utc':START.isoformat(),'end_utc':END.isoformat(),'streams':len(STREAMS),'steps':len(TURNS),'output_chars':sum(t['output_chars']for t in TURNS),'retained_chars':sum(t['retained_chars']for t in TURNS),'mature_chars':sum(t['mature_chars']for t in TURNS),'successful_write_chars':sum(t['successful_write_chars']for t in TURNS),'observable_write_chars':sum(t['observable_write_chars']for t in TURNS),'unknown_mutation_calls':sum(t['unknown_mutation_calls']for t in TURNS),'candidate_streams':len(hits),'aggregate':aggregate,'legacy_aggregate':legacyaggregate,'observed_families':len(familyrows),'explicit_multistream_families':sum(r['member_streams']>1 for r in familyrows),'models':models,'stats':dict(STATS),'repos':list(REPOS.values()),'sensitivity':{str(w):{'candidates':len(v),'median_context':median([x['context']for x in v])if v else None}for w,v in sens.items()}}
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
    text=['# Retrospective persistence and context probe','',f'Window: **{START.isoformat()} ≤ event timestamp < {END.isoformat()}** (21 rolling days).','Scope: all locally recorded projects, Pi + Claude Code + Codex. Current analysis stream and verified Pi faux test-model responses excluded; fixture sources remain auditable in excluded-fixtures.csv. No fetch, push, or source mutation.','',
    '## Method and interpretation','',
    '- Canonical mtime discovery preserved, followed by event-level rolling-window restriction. File streams are not necessarily independent user sessions. Existing scenario classifier is reused unchanged; its signals cover the whole recorded stream, not just this time slice.',
    '- An inference step is one assistant response in Pi/Claude; Codex uses per-response token_usage_record when present, otherwise last_token_usage events. This is not a user-turn count.',
    '- Denominator: observable assistant text, visible thinking, and tool-argument characters; normalized compact JSON for Pi/Claude arguments and original call source for Codex. Hidden/encrypted reasoning is unavailable. This is NOT total model-output yield and is not directly comparable across harnesses.',
    '- Attempted write characters: Write content, Edit replacement text, and literal apply_patch added lines. Arbitrary shell/programmatic writes are NOT reconstructed. Failed writes are excluded from persistence matching; unknown tool results are not assumed successful.',
    '- Numerator: exact added/replacement lines (minimum 16 non-whitespace characters), on a locally available default-branch snapshot, whose blame commit is within the window and at/after a successful tool call. Pre-existing blamed lines are excluded. Repeated lines across different streams are marked ambiguous, never credited twice. Within one stream, credit goes to the last eligible write. This is a conservative proxy, not proof of authorship or accepted utility.',
    '- Mature numerator: those currently surviving lines with blame origin at least seven days old. Recent changes are immature, not failed. Local default-branch reachability does not prove deployment/acceptance or live remote state. Ref tips are recorded in summary.json.',
    '- Topology uses the existing four-form classifier, keeping historical S1-S4 separate. Claude/Codex cannot identify all four forms with existing instrumentation. families.csv merges Claude child streams using explicit parent-directory lineage. Pi/Codex cross-session family linkage remains incomplete; no temporal-overlap heuristic is used.',
    '- Context candidates: solo streams only. Window=10 inference steps; marginal rate=persisted characters / observable output characters. Baseline=first window with ≥3 successfully mutated, blame-observable file steps with snapshot tip at/after the write and ≥100 matched characters. Require at least 80% observable written-character coverage and three successive eligible windows below one third of baseline. Reset across model/compaction boundaries; exploration-only windows are skipped. Delegating streams require verified child-value attribution and are excluded from this detector.',
    '- Overlapping windows are correlated. These are exploratory candidates, not calibrated compaction thresholds or causal evidence. Medians are withheld for fewer than five independent candidate families. No thresholds are installed.',
    '', '## Coverage', '',f'Active file streams: {len(STREAMS)}; inference steps: {len(TURNS):,}; output characters observed: {summary["output_chars"]:,}.',f'Git-blame observable, snapshot-covered successful-write characters: {summary["observable_write_chars"]:,} / {summary["successful_write_chars"]:,}. Possible shell/programmatic mutation calls not reconstructed: {summary["unknown_mutation_calls"]:,}.',f'Single-source retained characters: {summary["retained_chars"]:,}; ≥7-day retained: {summary["mature_chars"]:,}; ambiguous retained: {STATS["ambiguous_retained_chars"]:,}.', '',
    '## Harness × scenario (observational; not a ranking)', '', '| Harness | Form | Streams | Steps | Output chars | Matched chars | ≥7 days chars | Proxy yield |','|---|---|---:|---:|---:|---:|---:|---:|']
    for a in aggregate:text.append(f'| {a["harness"]} | {a["form"]} | {a["streams"]} | {a["inference_steps"]} | {a["output_chars"]:,} | {a["retained_chars"]:,} | {a["mature_chars"]:,} | {format_pct(a["yield_pct"])} |')
    text+=['','## Historical scenarios (separate taxonomy)','','S1=no delegation/coordination signals; S2=delegation only; S3=coordination only; S4=both. This table does not establish complete family attribution.','','| Harness | Scenario | Streams | Output chars | Matched chars | Proxy yield |','|---|---|---:|---:|---:|---:|']
    for a in legacyaggregate:text.append(f'| {a["harness"]} | {a["legacy"]} | {a["streams"]} | {a["output_chars"]:,} | {a["retained_chars"]:,} | {format_pct(a["yield_pct"])} |')
    text+=['','## Candidate context decline by model','','| Harness | Model | Steps with context | Median context | Candidate streams | Median candidate context (n≥5) |','|---|---|---:|---:|---:|---:|']
    for m in models:text.append(f'| {m["harness"]} | {m["model"]} | {m["context_observed_steps"]} | {m["median_context"]} | {m["candidate_streams"]} | {m["median_candidate_context"]} |')
    text+=['','## Window sensitivity','',json.dumps(summary['sensitivity'],indent=2),'','## Diagnostics','', '```json',json.dumps(dict(STATS),indent=2),'```','','## Files','','- excluded-fixtures.csv: verified Pi faux-provider test transcripts excluded from operational cohorts.', '- families.csv: explicitly linked Claude families; unlinked streams remain separate.', '- legacy-scenarios.csv: historical S1-S4 aggregations, never relabeled as four forms.', '- streams.csv: scenario and per-stream numerator/denominator.', '- turns.csv: context, output, mutation signals, and retained characters per inference step.', '- line-evidence.csv: content hashes and blame provenance, without raw file content.', '- candidates.csv: decline points, baseline, and observed window rate.', '- models.csv: context coverage and candidate medians.', '- curves.html: top matched streams, context versus cumulative matched characters; ordered paths preserve temporal traversal.', '- summary.json: exact reference snapshots and diagnostics.']
    (OUT/'report.md').write_text('\n'.join(text)+'\n')
    curves=['<!doctype html><meta charset="utf-8"><title>Persistence and context curves</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto}svg{background:#fafafa;border:1px solid #ddd}small{color:#555}</style><h1>Persistence and context curves</h1><p>Exploratory exact-line persistence proxy. X: context tokens. Y: cumulative retained characters, attributed retrospectively. Lines follow inference-step order; compaction/model boundaries start new paths. Not a causal compaction rule.</p>']
    for s in sorted(STREAMS,key=lambda s:sum(t['retained_chars']for t in s['turns']),reverse=True)[:18]:
        rows=sorted(s['turns'],key=lambda t:t['time']);valid=[t for t in rows if t['context']]
        if not valid:continue
        maxx=max(t['context']for t in valid);maxy=sum(t['retained_chars']for t in rows)or 1;y=0;parts=[];pts=[];seg=None
        for t in rows:
            y+=t['retained_chars']
            if not t['context']:continue
            newseg=(t['segment'],t['model'])
            if seg is not None and newseg!=seg:
                parts.append(pts);pts=[]
            seg=newseg;pts.append((70+850*t['context']/maxx,320-270*y/maxy))
        if pts:parts.append(pts)
        curves.append(f'<h2>{html.escape(s["harness"])} · {html.escape(s["form"])}</h2><small>{html.escape(s["source"])}</small><br><svg viewBox="0 0 1000 380" width="100%"><path d="M70 30V320H930" fill="none" stroke="#888"/>')
        for pts in parts:curves.append('<polyline fill="none" stroke="#175ca8" stroke-width="2" points="'+' '.join(f'{x:.2f},{y:.2f}'for x,y in pts)+'"/>')
        curves.append(f'<text x="70" y="350">0</text><text x="830" y="350">{maxx:,} tokens</text><text x="5" y="30">{maxy:,}</text><text x="350" y="375">Context → cumulative retained characters</text></svg>')
    (OUT/'curves.html').write_text('\n'.join(curves))
    print(json.dumps({k:summary[k]for k in ['streams','steps','output_chars','retained_chars','mature_chars','candidate_streams','sensitivity','stats']},indent=2),flush=True)

if __name__=='__main__':discover();report(match_git())
