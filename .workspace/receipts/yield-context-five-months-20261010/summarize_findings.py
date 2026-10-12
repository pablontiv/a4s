from pathlib import Path
import csv,json,collections,statistics
def pct(v,places=3):return 'N/A'if v is None else f'{v:.{places}f}%'
assert pct(None)=='N/A' and pct(0)=='0.000%'
P=Path('/Users/Shared/harness/a4s/.workspace/receipts/yield-context-five-months-20261010')
s=json.loads((P/'summary.json').read_text());old=json.loads(Path('/Users/Shared/harness/a4s/.workspace/receipts/yield-context-20261010/summary.json').read_text())
turns=list(csv.DictReader((P/'turns.csv').open()));streams=list(csv.DictReader((P/'streams.csv').open()));lines=list(csv.DictReader((P/'line-evidence.csv').open()));hits=list(csv.DictReader((P/'candidates.csv').open()));families=list(csv.DictReader((P/'families.csv').open()))
assert len(turns)==s['steps'] and len(streams)==s['streams']
for k in ['output_chars','retained_chars','mature_chars','successful_write_chars','observable_write_chars','unknown_mutation_calls']:assert sum(int(r[k])for r in turns)==s[k],k
assert sum(int(r['characters'])for r in lines if r['attribution']=='single-source-exact-match')==s['retained_chars']
assert len({(r['repo'],r['snapshot_sha'],r['file'],r['line'])for r in lines})==len(lines)
assert sum(int(r['output_chars'])for r in families)==s['output_chars']
assert all(int(t['retained_chars'])<=int(t['successful_write_chars'])for t in turns)
assert all(not t['model'].startswith('faux-')for t in turns)
byh=collections.defaultdict(list);bys=collections.defaultdict(list);bycohort=collections.defaultdict(list)
legacy={r['key']:r['legacy']for r in streams}
for t in turns:
 byh[t['harness']].append(t);bys[(t['harness'],legacy[t['stream']])].append(t)
 bycohort[(t['timestamp'][:7],t['harness'],t['model'],legacy[t['stream']])].append(t)
def stats(rs):
 v={k:sum(int(r[k])for r in rs)for k in ['output_chars','retained_chars','mature_chars','successful_write_chars','observable_write_chars','unknown_mutation_calls']}
 v.update({'streams':len({r['stream']for r in rs}),'inference_steps':len(rs),'proxy_yield_pct':100*v['retained_chars']/v['output_chars']if v['output_chars']else None,'git_observable_written_char_pct':100*v['observable_write_chars']/v['successful_write_chars']if v['successful_write_chars']else None})
 return v
harness=[dict(harness=h,**stats(rs))for h,rs in sorted(byh.items())]
scenarios=[dict(harness=h,legacy_scenario=sc,**stats(rs))for(h,sc),rs in sorted(bys.items())]
cohorts=[dict(month=mo,harness=h,model=m,legacy_scenario=sc,**stats(rs))for(mo,h,m,sc),rs in sorted(bycohort.items())]
points=collections.defaultdict(list)
for hit in hits:points[(hit['harness'],hit['model'])].append(hit)
candidates=[]
for(h,m),rs in sorted(points.items()):
 xs=[int(r['context'])for r in rs];ids={r['family']for r in rs}
 candidates.append({'harness':h,'model':m,'candidate_streams':len(rs),'observed_candidate_families':len(ids),'median_context_tokens':statistics.median(xs),'minimum_context_tokens':min(xs),'maximum_context_tokens':max(xs),'status':'exploratory; not a validated compaction threshold'})
cat=collections.Counter()
for r in lines:
 if r['attribution']!='single-source-exact-match':continue
 f=r['file'];kind='Markdown'if Path(f).suffix=='.md'else('test-named files'if any(x in f.lower()for x in ['/test/','/tests/','.test.','.spec.','test_'])else 'other code/configuration')
 cat[kind]+=int(r['characters'])
def write(name,rs):
 if not rs:return
 with(P/name).open('w')as f:
  w=csv.DictWriter(f,list(rs[0]));w.writeheader();w.writerows(rs)
write('harness-summary.csv',harness);write('scenario-summary.csv',scenarios);write('monthly-model-scenario-cohorts.csv',cohorts);write('candidate-model-summary.csv',candidates)
metrics={'start_utc':s['start_utc'],'end_utc':s['end_utc'],'five_month_metrics':{k:s[k]for k in ['streams','steps','output_chars','retained_chars','mature_chars','successful_write_chars','observable_write_chars','candidate_streams']},'three_week_metrics':{k:old[k]for k in ['streams','steps','output_chars','retained_chars','mature_chars','successful_write_chars','observable_write_chars','candidate_streams']},'harness_summary':harness,'scenario_summary':scenarios,'candidate_model_summary':candidates,'artifact_categories':dict(cat),'candidate_observed_families':len({h['family']for h in hits}),'method_limits':['Proxy denominator is observable text/thinking/tool-argument characters, not full hidden model output.','Retained chars are exact-line single-source matches in local default refs, not an accepted utility score.','Old paths and arbitrary shell writes are incompletely attributable.','Expanding the candidate pool can turn formerly unique matches into ambiguous attribution; persistence numerators are not additive across window expansions.','Backscroll archived records lack native context usage and may have incomplete tool input. They are included in availability census, not invented native yield or candidate calculations.','OpenCode is present in indexed history but not supported by this three-harness native probe; yield/context candidate results for it are N/A.','No classifier, Git ref, or compaction configuration was changed.']}
(P/'numerical-findings.json').write_text(json.dumps(metrics,indent=2));coverage=100*s['observable_write_chars']/s['successful_write_chars']
text=['# Five-month numerical findings','',f'Window: {s["start_utc"]} ≤ timestamp < {s["end_utc"]}. All locally available projects in Pi, Claude Code and Codex. Same evaluation endpoint as the three-week probe.','', '## Requested persistence numbers','','| Period | Active streams | Inference steps | Output chars observed | Retained-match chars | ≥7-day chars | Git written-char coverage |','|---|---:|---:|---:|---:|---:|---:|']
for label,rs in [('Three weeks',old),('Five months',s)]:text.append(f'| {label} | {rs["streams"]:,} | {rs["steps"]:,} | {rs["output_chars"]:,} | {rs["retained_chars"]:,} | {rs["mature_chars"]:,} | {100*rs["observable_write_chars"]/rs["successful_write_chars"]:.2f}% |')
text+=['','## Harness totals','','| Harness | Streams | Steps | Output chars | Retained chars | Proxy yield | Git written-char coverage |','|---|---:|---:|---:|---:|---:|---:|']
for r in harness:text.append(f'| {r["harness"]} | {r["streams"]} | {r["inference_steps"]:,} | {r["output_chars"]:,} | {r["retained_chars"]:,} | {pct(r["proxy_yield_pct"])} | {pct(r["git_observable_written_char_pct"],2)} |')
text+=['| OpenCode (indexed historical corpus) | N/A | N/A | N/A | N/A | N/A | N/A |','','OpenCode and absent native-source records are not represented as zero delivery. Native yield remains unmeasured for them.','','## Historical scenario breakdown','','S1=no delegation/coordination signals; S2=delegation only; S3=coordination only; S4=both. This is distinct from the four-form model. Counts are source streams, not complete family-level costs.','','| Harness | Scenario | Streams | Retained chars | Proxy yield | Git written-char coverage |','|---|---|---:|---:|---:|---:|']
for r in scenarios:text.append(f'| {r["harness"]} | {r["legacy_scenario"]} | {r["streams"]} | {r["retained_chars"]:,} | {pct(r["proxy_yield_pct"])} | {pct(r["git_observable_written_char_pct"],2)} |')
text+=['','## Compaction candidate numbers','','Each median below is descriptive. No sample-count rule alone makes it a valid compaction policy.','','| Harness | Model | Candidate streams | Observed families | Median context | Range |','|---|---|---:|---:|---:|---|']
for r in candidates:text.append(f'| {r["harness"]} | {r["model"]} | {r["candidate_streams"]} | {r["observed_candidate_families"]} | {r["median_context_tokens"]:,.0f} | {r["minimum_context_tokens"]:,}–{r["maximum_context_tokens"]:,} |')
if not candidates:text.append('| N/A | N/A | 0 | 0 | N/A | N/A |')
text+=['','Total observed candidate families: '+str(metrics['candidate_observed_families'])+'. Window=10 inference steps, three successive eligible overlapping windows below one third of first productive-window yield, ≥80% observable write-character coverage. Delegating coordinator streams are excluded without complete child-value attribution.','', 'Window sensitivity: '+json.dumps(s['sensitivity']), '', '## Artifact categories','','Filename-based exact-match char categories: '+json.dumps(dict(cat)), '', '## Interpretation limits','']+['- '+x for x in metrics['method_limits']]
text+=['','## Verification','','Eighteen regression checks pass, including legacy JSON-string edits and malformed-edit rejection. CSV totals, line uniqueness, written-character caps and fixture exclusions were independently checked.','','Full method and diagnostics: report.md. Curves: curves.html. Native evidence: line-evidence.csv and turns.csv. Monthly stratification: monthly-model-scenario-cohorts.csv. Indexed historical availability: ../yield-context-20261010/backscroll-census.json.']
(P/'numerical-findings.md').write_text('\n'.join(text)+'\n')
print('Five-month numerical consistency: PASS');print(json.dumps(metrics,indent=2))
