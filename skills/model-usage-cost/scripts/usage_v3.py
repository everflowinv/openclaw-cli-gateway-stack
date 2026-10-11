"""Additional local metering sources and explicit cross-layer reconciliation."""
import collections
import json
from pathlib import Path
import usage_sources as s

GATEWAYS = ('claude-cli-gateway', 'antigravity-cli-gateway', 'muse-cli-gateway')


def openai_vector(u):
    inp, cw, cr, out = s.vector(u, ('input_tokens','cache_write_input_tokens','cached_input_tokens','output_tokens'))
    if cw + cr > inp: raise ValueError('cache exceeds input')
    return (inp-cw-cr, cw, cr, out)


def gateway_vector(u):
    inp, cw, out = s.vector(u, ('prompt_tokens','cache_creation_input_tokens','completion_tokens'))
    cr = s.number((u.get('prompt_tokens_details') or {}).get('cached_tokens', 0))
    if cr > inp: raise ValueError('cache exceeds input')
    return (inp-cr, cw, cr, out)


def scan_compactions(e):
    for kind, source in [('rollout-openclaw','openclaw'),('rollout-manual','codex-cli(手动)')]:
        for path in e.paths(kind):
            model, thread, turn = 'unknown', Path(path).stem, None
            for n, line in e.lines(path):
                if not any(t in line for t in ('"session_meta"','"turn_context"','"compacted"')): continue
                o=e.parse(line,path,n); p=o.get('payload') or {}; typ=o.get('type')
                if typ=='session_meta': thread=p.get('id') or thread
                elif typ=='turn_context': model=p.get('model') or model; turn=p.get('turn_id') or turn
                elif typ=='compacted':
                    ts=s.timestamp(o.get('timestamp'))
                    if ts is None or not e.since<=ts<e.until: continue
                    latest=p.get('latest_token_usage_record') or {}; rid=p.get('compaction_response_id')
                    if not rid or rid!=latest.get('response_id') or not isinstance(latest.get('usage'),dict):
                        e.issue('codex_compaction_usage_unknown',path); continue
                    try: v=openai_vector(latest['usage'])
                    except ValueError: e.issue('codex_compaction_usage_invalid',path); continue
                    e.put('codex-compaction',rid,ts,'openai',model,source,v,
                          thread=latest.get('thread_id') or thread,turn=latest.get('turn_id') or turn,
                          response=rid,unit='model-response',time_basis='completion')


def reconcile_compactions(e, active):
    ordinary=collections.defaultdict(list)
    for r in active.values():
        if r['kind']=='codex': ordinary[(r['meta'].get('turn'),tuple(r['v']))].append(r)
    for r in list(active.values()):
        if r['kind']!='codex-compaction': continue
        matches=[x for x in ordinary.get((r['meta'].get('turn'),tuple(r['v'])),[]) if abs(x['ts']-r['ts'])<5]
        if len(matches)==1:
            active.pop(r['id']);e.stats['codex_compaction_token_event_overlap']+=1


def agy_models(c):
    """Generation metadata contains model name and enum; no text payload retained."""
    result=collections.defaultdict(set)
    if not c.execute("SELECT 1 FROM sqlite_master WHERE name='gen_metadata'").fetchone(): return result
    for raw, in c.execute('SELECT data FROM gen_metadata'):
        d=s.wire(raw); meta=s.wire(s.first(d,1,b'')); name=s.first(meta,19,b'').decode()
        if not name: continue
        for entry in meta.get(20,[]):
            kv=s.wire(entry)
            if s.first(kv,1,b'')!=b'model_enum': continue
            value=s.first(kv,2,b'').decode()
            if value.startswith('MODEL_PLACEHOLDER_M') and value[19:].isdigit():
                result[1000+int(value[19:])].add(s.base_model(name))
    return result


def project_compressed_transcripts(c, project):
    columns={row[1] for row in c.execute('PRAGMA table_info(transcript_events)')}
    if 'event_zstd' not in columns: return
    try:
        from compression import zstd
        decode=zstd.decompress
    except ImportError:
        import zstandard
        decode=zstandard.ZstdDecompressor().decompress
    for raw, in c.execute('SELECT event_zstd FROM transcript_events WHERE event_zstd IS NOT NULL'):
        project((json.loads(decode(raw)).get('message') or {}))


def scan_muse(e):
    # Native Muse sessions, including subagents. Exact IDs also occur in gateway logs.
    for path in e.paths('muse-sessions'):
        for n,line in e.lines(path):
            if 'model_completed' not in line: continue
            o=e.parse(line,path,n); p=o.get('payload') or {}; event=p.get('event') or {}
            if event.get('kind')!='model_completed': continue
            raw_time=o.get('recorded_at'); ts=raw_time/1e6 if isinstance(raw_time,(int,float)) else s.timestamp(raw_time)
            if ts is None or not e.since<=ts<e.until: continue
            u=event.get('usage');rid=p.get('run_id');mid=p.get('source_run_record_id') or o.get('id')
            if not rid or not mid: e.issue('muse_identity_missing',path); continue
            try:
                inp,cw,cr,out=s.vector(u,('input_tokens','cache_write_tokens','cached_tokens','output_tokens'))
                if cr+cw>inp: raise ValueError('cache exceeds input')
                v=(inp-cr-cw,cw,cr,out)
            except ValueError: e.issue('muse_usage_invalid',path); continue
            e.put('muse',rid+':'+mid,ts,'muse-cli-gateway',event.get('model'),'muse-cli(手动)',v,
                  unit='model-response',subagent='/subagent/' in path,time_basis='completion')
    events=[]
    for path in e.paths('muse-gateway'):
        for n,line in e.lines(path):
            if not line.startswith('[MUSEGW] ') or not any('"'+k+'"' in line for k in ('start','usage','done','error','cancel')):continue
            events.append(e.parse(line[len('[MUSEGW] '):],path,n))
    starts={};seen=set()
    for o in sorted(events,key=lambda x:x.get('ts','')):
        sig=s.digest(o)
        if sig in seen:continue
        seen.add(sig);req=o.get('request');ts=s.timestamp(o.get('ts'));typ=o.get('event')
        if typ=='start':starts[req]=o;continue
        if ts is None or not e.since<=ts<e.until:continue
        if typ=='usage':
            for call in o.get('modelCalls',[]):
                try:v=gateway_vector(call.get('usage'))
                except (ValueError,TypeError):e.issue('muse_gateway_invalid_usage',req);continue
                if not call.get('id'):e.issue('muse_identity_missing',req);continue
                e.put('muse',call['id'],ts,'muse-cli-gateway',call.get('model'),'openclaw',v,
                      request=req,unit='model-response',scope=call.get('scope'),time_basis='completion')
        elif typ=='done':
            try:v=gateway_vector(o.get('usage'))
            except (ValueError,TypeError):e.issue('muse_gateway_usage_unknown',req);continue
            start=starts.get(req) or {};lo=s.timestamp(start.get('ts'));reported=None
            if isinstance(o.get('usage_reported'),dict):reported=gateway_vector(o['usage_reported'])
            e.put('gateway',s.digest('muse-cli-gateway',req,start.get('ts')or o['ts']),ts,'muse-cli-gateway',o.get('model')or start.get('model'),'openclaw',v,
                  request=req,request_uuid=req,start=lo,session=start.get('session'),reported_v=reported,unit='gateway-request',time_basis='completion')
        elif typ in ('error','cancel'):e.issue('muse_gateway_failed_or_cancelled',req)


def reconcile_muse(e, active, held, gateways):
    by_request=collections.defaultdict(list)
    for r in active.values():
        if r['kind']=='muse' and r['meta'].get('request'):by_request[r['meta']['request']].append(r)
    for g in gateways:
        if g['provider']!='muse-cli-gateway':continue
        children=by_request.get(g['meta'].get('request'),[])
        if not children:continue
        if s.summed(children)==tuple(g['v']):
            active.pop(g['id'],None);g['meta']['replaced_by']=[r['id'] for r in children]
            e.stats['muse_gateway_reconciled']+=1
        else:
            active.pop(g['id'],None);held.append(g);e.issue('muse_gateway_sum_mismatch',g['id'])


def reconcile_dalton(e, active, held, gateways):
    """One-to-one historical inference; uncertain overlaps remain outside totals."""
    index=collections.defaultdict(dict);by_model=collections.defaultdict(list)
    for g in gateways:
        # Do not suppress evidence against an aggregate that itself has no authority.
        if g['id'] not in active and not any(k in active for k in g['meta'].get('replaced_by',[])):continue
        key=(g['provider'],s.base_model(g['model']));by_model[key].append(g)
        for v in (g['v'],g['meta'].get('reported_v')):
            if v is not None:index[key+(tuple(v),)][g['id']]=g
    candidates={};reverse=collections.Counter()
    for d in active.values():
        if d['kind']!='dalton' or d['provider'] not in GATEWAYS:continue
        key=(d['provider'],s.base_model(d['model']))
        matches=[]
        for g in index.get(key+(tuple(d['v']),),{}).values():
            lo=g['meta'].get('start') or g['ts']
            # Explicit IDs, when supplied by newer telemetry, supersede inference.
            rid=d['meta'].get('gateway_request_uuid')
            if rid:
                if rid!=g['meta'].get('request_uuid'):continue
            elif not lo-120<=d['ts']<=g['ts']+2:continue
            matches.append(g)
        candidates[d['id']]=matches
        for g in matches:reverse[g['id']]+=1
    for did, matches in candidates.items():
        d=active[did]
        if len(matches)==1 and reverse[matches[0]['id']]==1:
            g=matches[0];active.pop(did)
            if e.since<=g['ts']<e.until:
                prefix='dalton_gateway_identity' if d['meta'].get('gateway_request_uuid') else 'dalton_gateway_inferred'
                e.stats[prefix+'_records']+=1;e.stats[prefix+'_tokens']+=sum(d['v'])
            targets=[active[g['id']]] if g['id'] in active else [active[k] for k in g['meta'].get('replaced_by',[]) if k in active]
            for target in targets:
                target['meta'].setdefault('upstream_invocations',[]).append(did)
                target['meta']['upstream_match_basis']='request-id' if d['meta'].get('gateway_request_uuid') else 'unique-usage-time'
        elif matches:
            active.pop(did);held.append(d);e.issue('dalton_gateway_ambiguous',did)
        else:
            near=[g for g in by_model.get((d['provider'],s.base_model(d['model'])),[]) if (g['meta'].get('start') or g['ts'])-2<=d['ts']<=g['ts']+2]
            if near:
                active.pop(did);held.append(d);e.issue('dalton_gateway_usage_unreconciled',did)
            elif d['meta'].get('time_basis')=='request-start':
                e.issue('dalton_gateway_completion_unknown',did)
