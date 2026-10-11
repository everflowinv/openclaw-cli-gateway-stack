"""Local usage evidence. No prompts, answers, credentials or response headers retained.

Counters are disjoint (fresh input, cache write, cache read, output including reasoning).
Raw observations are persisted BEFORE reconciliation, so later evidence can replace a
fallback without counting both. Unknown/overlapping aggregates stay outside totals.
"""
import collections
import datetime as dt
import glob
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3

UTC = dt.timezone.utc
FIELDS = ('fresh', 'cw', 'cr', 'out')
ROOTS = {
 'rollout-openclaw': ['~/.openclaw/agents/*/agent/codex-home/sessions/**/rollout-*.jsonl', '~/.openclaw/acpx/codex-home/sessions/**/rollout-*.jsonl', '~/.openclaw/agents/*/agent/codex-home/archived_sessions/**/rollout-*.jsonl'],
 'rollout-manual': ['~/.codex/sessions/**/rollout-*.jsonl', '~/.codex/archived_sessions/**/rollout-*.jsonl'],
 'claude': ['~/.claude/projects/**/*.jsonl'],
 'trajectory-db': ['~/.openclaw/agents/*/agent/openclaw-agent.sqlite'],
 'trajectory-file': ['~/.openclaw/agents/*/sessions/*.trajectory.jsonl', '~/.openclaw/agents/*/session-sqlite-import-archive/*.trajectory.jsonl.imported-*'],
 'claude-gateway': ['~/.openclaw/logs/claude-cli-gateway.stdout.log*'],
 'agy-gateway': ['~/.openclaw/logs/antigravity-cli-gateway.stdout.log*'],
 'muse-sessions': ['~/.local/share/muse/sessions/**/session.jsonl'],
 'muse-gateway': ['~/.openclaw/logs/muse-cli-gateway.stdout.log*'],
 'agy-db': ['~/.gemini/antigravity-cli/conversations/*.db'],
 'dalton-db': ['~/Library/Application Support/Dalton/state/dalton-core/core.sqlite'],
 'broker': ['~/.openclaw/dalton-model-broker.sock.journal.json'],
 'zcode-db': ['~/.zcode/cli/db/db.sqlite'],
 'zcode-rollout': ['~/.zcode/cli/rollout/model-io-*.jsonl'],
}


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) / (1000 if value > 1e11 else 1)
    if not isinstance(value, str):
        return None
    try:
        parsed=dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None: parsed=parsed.replace(tzinfo=UTC)
        return parsed.timestamp()
    except ValueError:
        return None


def number(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0 or int(x) != x:
        raise ValueError('invalid token counter')
    return int(x)


def vector(u, keys):
    if not isinstance(u, dict) or not any(k in u and u[k] is not None for k in keys):
        raise ValueError('usage unavailable')
    return tuple(number(0 if u.get(k) is None else u[k]) for k in keys)


def digest(*values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def dbopen(path):
    if not Path(path).is_file(): raise FileNotFoundError(path)
    uri = Path(path).resolve().as_uri()
    try:
        c = sqlite3.connect(uri + '?mode=ro', uri=True)
        c.execute('PRAGMA query_only=ON')
        return c
    except sqlite3.OperationalError as error:
        # A cleanly closed WAL database (no -wal/-shm sidecars) cannot be opened read-only.
        # Without a -wal file, immutable mode sees the complete committed content and creates no files.
        if 'unable to open database file' not in str(error) or os.path.exists(str(path) + '-wal'):
            raise
        c = sqlite3.connect(uri + '?immutable=1', uri=True)
        c.execute('PRAGMA query_only=ON')
        return c


def files(kind):
    return sorted({str(Path(p).resolve()) for pat in ROOTS[kind] for p in glob.glob(os.path.expanduser(pat), recursive=True) if os.path.isfile(p)})


class Evidence:
    def __init__(self, since, until):
        self.since, self.until = since, until
        self.records = {}
        self.stats = collections.Counter()
        self.issues = collections.Counter()
        self.examples = {}
        self.inventory = {}

    def issue(self, code, detail=''):
        self.issues[code] += 1
        if detail and len(self.examples.setdefault(code, [])) < 3:
            self.examples[code].append(str(detail))

    def paths(self, kind):
        out = files(kind)
        self.inventory[kind] = len(out)
        return out

    def lines(self, path):
        opener = gzip.open if path.endswith('.gz') else open
        with opener(path, 'rt', encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f, 1):
                if line.strip():
                    yield i, line

    def parse(self, line, path, lineno):
        try:
            o = json.loads(line)
            return o if isinstance(o, dict) else {}
        except (ValueError, TypeError):
            self.issue('malformed_json', '%s:%s' % (path, lineno))
            return {}

    def put(self, kind, ident, ts, provider, model, source, v, **meta):
        if ts is None:
            self.issue('missing_timestamp', kind)
            return
        if not self.since <= ts < self.until:
            return
        try:
            v = tuple(number(x) for x in v)
        except ValueError:
            self.issue('invalid_usage', kind)
            return
        if not any(v) and kind != 'dalton':
            self.stats[kind + '_zero_usage'] += 1
            return
        key = kind + ':' + ident
        rec = dict(id=key, kind=kind, ts=ts, provider=provider or 'unknown', model=model or 'unknown', source=source, v=v, meta=meta)
        old = self.records.get(key)
        if old:
            self.stats[kind + '_duplicates'] += 1
            if tuple(old['v']) != v:
                # Repeated message blocks may carry partial -> final usage. Never
                # sum them; monotonic completion wins, other conflicts are exposed.
                if all(b >= a for a, b in zip(old['v'], v)):
                    rec['ts'] = old['ts']
                elif all(a >= b for a, b in zip(old['v'], v)):
                    return
                else:
                    self.issue('conflicting_identity_usage', key)
                    return
            else:
                return
        self.records[key] = rec

    def usage(self, u, keys, label):
        try:
            return vector(u, keys)
        except ValueError as e:
            self.issue(str(e).replace(' ', '_'), label)
            return None


def scan_rollouts(e, kinds=None):
    for kind, source in (kinds or [('rollout-openclaw', 'openclaw'), ('rollout-manual', 'codex-cli(手动)')]):
        for path in e.paths(kind):
            model, thread, turn, previous = 'unknown', Path(path).stem, None, None
            # Early records in older rollouts precede their first turn_context.
            for _, early in e.lines(path):
                if '"turn_context"' not in early: continue
                try: context=json.loads(early)
                except ValueError: continue
                if context.get('type')=='turn_context' and isinstance((context.get('payload') or {}).get('model'),str):
                    model=context['payload']['model'];break
            for n, line in e.lines(path):
                # Parsing only relevant lines avoids retaining the conversation.
                if not any(t in line for t in ('"session_meta"', '"turn_context"', '"token_count"', '"task_started"')):
                    continue
                o = e.parse(line, path, n); p = o.get('payload') or {}; typ = p.get('type', o.get('type'))
                if typ == 'session_meta':
                    thread = p.get('id') or thread
                elif typ in ('turn_context', 'task_started'):
                    model = p.get('model') or model; turn = p.get('turn_id') or turn
                elif typ == 'token_count':
                    info = p.get('info') or {}; u = info.get('last_token_usage'); cumulative = info.get('total_token_usage')
                    ts = timestamp(o.get('timestamp'))
                    if not isinstance(u, dict):
                        continue  # rate-limit-only events contain no usage
                    signature = tuple(cumulative.get(k, 0) for k in ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'total_tokens')) if isinstance(cumulative, dict) else None
                    if signature is not None and signature == previous:
                        if ts is not None and e.since <= ts <= e.until:
                            e.stats[kind + '_unchanged_counter_events'] += 1
                            e.stats[kind + '_unchanged_counter_tokens'] += (u.get('input_tokens') or 0) + (u.get('output_tokens') or 0)
                        continue
                    if signature is not None and previous is not None and signature[0] < previous[0]:
                        if ts is not None and e.since <= ts <= e.until:
                            e.stats['codex_counter_resets'] += 1
                    previous = signature
                    if ts is None or not e.since <= ts <= e.until:
                        continue
                    v = e.usage(u, ('input_tokens', 'cache_write_input_tokens', 'cached_input_tokens', 'output_tokens'), path)
                    if v is None:
                        continue
                    inp, cw, cr, out = v
                    if cr + cw > inp:
                        e.issue('codex_cache_exceeds_input', thread); continue
                    if signature is None:
                        e.issue('codex_missing_cumulative_counter', thread)
                    # turn IDs and original timestamps survive copied/forked history.
                    identity = digest(turn or thread, o.get('timestamp'), signature, u)
                    e.put('codex', identity, ts, 'openai', model, source, (inp-cr-cw, cw, cr, out), thread=thread, turn=turn, unit='model-response')


def scan_claude(e):
    for path in e.paths('claude'):
        for n, line in e.lines(path):
            if '"usage"' not in line:
                continue
            o = e.parse(line, path, n)
            if o.get('type') != 'assistant':
                continue
            msg = o.get('message') or {}; u = msg.get('usage'); ts = timestamp(o.get('timestamp'))
            if not isinstance(msg, dict) or msg.get('model') == '<synthetic>' or ts is None or not e.since <= ts <= e.until:
                continue
            v = e.usage(u, ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'), path)
            if v is None:
                continue
            mid = msg.get('id')
            if not mid:
                e.issue('claude_missing_message_id', path)
                mid = digest(o.get('sessionId'), o.get('uuid'), ts, u)
            e.put('claude', mid, ts, 'anthropic', msg.get('model'), 'claude-code(手动)', v, unit='model-response', subagent='/subagents/' in path)


def scan_gateway(e, kind, split):
    provider, prefix = ('claude-cli-gateway', '[CLIGW] ') if kind == 'claude-gateway' else ('antigravity-cli-gateway', '[AGYGW] ')
    events = []
    for path in e.paths(kind):
        for n, line in e.lines(path):
            if not line.startswith(prefix) or not any('"'+x+'"' in line for x in ('start', 'init', 'done', 'error', 'cancel', 'usage')):
                continue
            o = e.parse(line[len(prefix):], path, n)
            if o.get('event') in ('start', 'init', 'done', 'error', 'cancel', 'usage'):
                events.append(o)
    starts, inits, seen = {}, {}, set()
    for o in sorted(events, key=lambda x: x.get('ts', '')):
        rid, typ, ts = o.get('request'), o.get('event'), timestamp(o.get('ts'))
        fingerprint = digest(o)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        if typ == 'start':
            starts[rid] = o; inits.pop(rid, None); continue
        if typ == 'init':
            inits[rid] = o.get('conversationId'); continue
        if typ == 'usage' and provider == 'claude-cli-gateway':
            u=o.get('usage') or {}; inp=u.get('prompt_tokens',0); cr=(u.get('prompt_tokens_details') or {}).get('cached_tokens',0)
            v=e.usage(dict(fresh=inp-cr,cw=u.get('cache_creation_input_tokens',0),cr=cr,out=u.get('completion_tokens',0)),FIELDS,rid)
            if v is not None and o.get('messageId'):
                e.put('claude',o['messageId'],ts,'anthropic',o.get('model'),'openclaw',v,request=rid,unit='model-response')
            continue
        if typ != 'done' and not (typ=='error' and isinstance(o.get('usage'),dict)):
            if ts is not None and e.since <= ts <= e.until:
                e.issue(kind + '_failed_or_cancelled_usage_unknown', rid)
            continue
        if ts is None or not e.since <= ts <= e.until:
            continue
        start = starts.get(rid) or {}; lo = timestamp(start.get('ts')); model = o.get('model') or start.get('model')
        u = o.get('usage'); raw = o.get('usage_raw'); estimated = False; legacy_out = False
        if kind == 'agy-gateway' and isinstance(raw, dict):
            v = e.usage(raw, ('input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens'), rid)
            # agy output already contains thinking. Legacy gateway added it twice.
        elif isinstance(u, dict):
            v0 = e.usage(u, ('prompt_tokens', 'cache_creation_input_tokens', 'completion_tokens'), rid)
            if v0 is None: continue
            inp, cw, out = v0
            cached = (u.get('prompt_tokens_details') or {}).get('cached_tokens')
            if isinstance(cached, (int, float)) and not isinstance(cached, bool):
                try: cr = number(cached)
                except ValueError: e.issue('invalid_usage', rid); continue
                if cr > inp: e.issue('gateway_cache_exceeds_input', rid); continue
                v = (inp-cr, cw, cr, out)
            elif kind == 'claude-gateway':
                fresh, cw = int(inp*split[0]), int(inp*split[1]); v = (fresh, cw, inp-fresh-cw, out); estimated = True
            else:
                v = (inp, 0, 0, out); estimated = True; legacy_out = True
        else:
            e.issue('gateway_usage_unavailable', rid); continue
        if v is None: continue
        if lo is None: e.issue('gateway_start_missing', rid)
        e.put('gateway', digest(provider, rid, start.get('ts') or o.get('ts')), ts, provider, model, 'openclaw', v,
              request=rid, start=lo, session=start.get('session'), conversation=inits.get(rid) or o.get('conversationId'),
              unit='gateway-request', estimated=estimated, legacy_out=legacy_out,
              request_uuid=o.get('requestUuid') or start.get('requestUuid'),
              reported_v=__import__('usage_v3').gateway_vector(o['usage_reported']) if isinstance(o.get('usage_reported'),dict) else None,
              time_basis='completion')


def scan_trajectories(e, include_db=True, include_files=True):
    transcript_messages=collections.defaultdict(list)
    def project_message(m):
        if isinstance(m,dict) and m.get('provider') in ('claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway') and m.get('responseId') and isinstance(m.get('usage'),dict):
            result={k:m.get(k) for k in ('timestamp','provider','model','usage','responseId')}
            run=(m.get('__openclaw') or {}).get('runId')
            if run: transcript_messages[run].append(result)
    def rows():
        for path in e.paths('trajectory-db') if include_db else []:
            c = dbopen(path)
            try:
                if c.execute("SELECT 1 FROM sqlite_master WHERE name='transcript_events'").fetchone():
                    for row in c.execute("SELECT json_extract(event_json,'$.message.timestamp'),json_extract(event_json,'$.message.provider'),json_extract(event_json,'$.message.model'),json_extract(event_json,'$.message.usage'),json_extract(event_json,'$.message.responseId'),json_extract(event_json,'$.message.__openclaw.runId') FROM transcript_events WHERE json_extract(event_json,'$.message.provider') IN ('claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway') AND json_extract(event_json,'$.message.responseId') IS NOT NULL"):
                        try: usage=json.loads(row[3]) if isinstance(row[3],str) else row[3]
                        except ValueError: continue
                        project_message(dict(timestamp=row[0],provider=row[1],model=row[2],usage=usage,responseId=row[4],__openclaw={'runId':row[5]}))
                    __import__('usage_v3').project_compressed_transcripts(c,project_message)
                for row in c.execute("SELECT event_json FROM trajectory_runtime_events WHERE json_extract(event_json,'$.type') IN ('session.started','model.completed')"):
                    yield path, 0, row[0]
            finally: c.close()
        for path in e.paths('trajectory-file') if include_files else []:
            for n, line in e.lines(path):
                if '"model.completed"' in line or '"session.started"' in line:
                    yield path, n, line
    starts, completed = {}, []
    for path, n, line in rows():
        o = e.parse(line, path, n); ts = timestamp(o.get('ts')); run = o.get('runId')
        if o.get('type') == 'session.started':
            if ts is not None: starts[run] = min(starts.get(run, ts), ts)
        elif o.get('type') == 'model.completed' and ts is not None and e.since <= ts <= e.until:
            d = o.get('data') or {}
            # Trim potentially huge prompt/snapshots immediately; retain only usage.
            messages = []
            for m in d.get('messagesSnapshot', []) if isinstance(d.get('messagesSnapshot'), list) else []:
                if isinstance(m, dict) and m.get('role') == 'assistant' and isinstance(m.get('usage'), dict) and m.get('responseId'):
                    messages.append({k:m.get(k) for k in ('timestamp', 'provider', 'model', 'usage', 'responseId')})
            o['_origin']=path
            completed.append(({k:o.get(k) for k in ('traceId','runId','seq','ts','provider','modelId','sessionKey','sessionId','_origin')}, {k:d.get(k) for k in ('usage','threadId','turnId')}, messages))
    # Snapshots can be truncated. Read only the matching archived transcript
    # files for gateway runs whose request IDs are absent, not every transcript.
    read_transcripts=set()
    for o,d,messages in completed:
        if o['provider'] not in ('claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway') or o['runId'] in transcript_messages or not o.get('sessionId'):continue
        origin=Path(o['_origin']);parts=origin.parts
        if 'agents' not in parts:continue
        root=Path(*parts[:parts.index('agents')+2]);sid=o['sessionId']
        candidates=glob.glob(str(root/'session-sqlite-import-archive'/('*'+sid+'.jsonl.imported-*')))+glob.glob(str(root/'sessions'/(sid+'.jsonl')))
        for path in candidates:
            if path in read_transcripts:continue
            read_transcripts.add(path)
            for n,line in e.lines(path):
                if '"responseId"' not in line or '"usage"' not in line:continue
                row=e.parse(line,path,n);project_message(row.get('message'))
    e.inventory['gateway-archive-transcripts']=len(read_transcripts)
    for o, d, messages in completed:
        messages += transcript_messages.get(o['runId'],[])
        ts, provider = timestamp(o['ts']), o['provider']; lo = starts.get(o['runId'])
        v = e.usage(d.get('usage'), ('input', 'cacheWrite', 'cacheRead', 'output'), o['runId'])
        if v is not None:
            e.put('trajectory', digest(o['traceId'], o['runId'], o['seq'], o['ts']), ts, provider, o['modelId'], 'openclaw', v,
                  thread=d.get('threadId'), turn=d.get('turnId'), run=o['runId'], start=lo, session=o['sessionKey'], unit='agent-run',
                  responses=[m['responseId'] for m in messages if m['provider']==provider and timestamp(m['timestamp']) is not None and (lo is None or timestamp(m['timestamp'])>=lo-1)])
        for m in messages:
            if m['provider'] not in ('claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway'): continue
            mv = e.usage(m['usage'], ('input','cacheWrite','cacheRead','output'), m['responseId'])
            if mv is not None:
                e.put('gateway-message', m['responseId'], timestamp(m['timestamp']), m['provider'], m['model'], 'openclaw', mv, response=m['responseId'], unit='gateway-request')


# Minimal protobuf wire decoder. Field numbers independently verified against the
# embedded DescriptorProto in agy 1.2.0; unknown fields are ignored, malformed data
# fails visibly. Never decode text/tool payloads or response headers.
def varint(b, i):
    n = shift = 0
    while i < len(b) and shift < 70:
        v = b[i]; i += 1; n |= (v & 127) << shift
        if v < 128: return n, i
        shift += 7
    raise ValueError('malformed protobuf varint')


def wire(b):
    result = collections.defaultdict(list); i = 0
    while i < len(b):
        tag, i = varint(b, i); field, typ = tag >> 3, tag & 7
        if not field: raise ValueError('invalid protobuf field')
        if typ == 0: v, i = varint(b, i)
        elif typ in (1, 2, 5):
            if typ == 2: size, i = varint(b, i)
            else: size = {1:8, 5:4}[typ]
            v = b[i:i+size]; i += size
            if i > len(b): raise ValueError('truncated protobuf field')
        else: raise ValueError('unsupported protobuf wire type')
        result[field].append(v)
    return result


def first(d, k, default=0):
    return d.get(k, [default])[0]


def pbtime(raw):
    d = wire(raw); return first(d, 1) + first(d, 2) / 1e9


def scan_agy(e):
    for path in e.paths('agy-db'):
        conv = Path(path).stem
        try: c = dbopen(path)
        except sqlite3.OperationalError as error:
            e.issue('agy_db_unreadable', '%s %s' % (conv, error)); continue
        try:
            models=__import__('usage_v3').agy_models(c)
            for idx, raw in c.execute('SELECT idx,metadata FROM steps WHERE metadata IS NOT NULL'):
                try:
                    d = wire(raw)
                    if 9 not in d: continue
                    u = wire(first(d, 9))
                    tsraw = first(d, 8, None) or first(d, 7, None) or first(d, 1, None)
                    ts = pbtime(tsraw) if tsraw else None
                    model_enum = first(u, 1)
                    usage = tuple(first(u, k) for k in (2,4,5,3))
                    response = first(u, 11, b'') or first(u, 7, b'')
                    mid = response.decode() if isinstance(response, bytes) and response else '%s:%s' % (conv, idx)
                    thinking, response_out = first(u, 9), first(u, 10)
                    if (thinking or response_out) and usage[3] != thinking + response_out:
                        e.issue('agy_output_partition_mismatch', conv)
                    names=models.get(model_enum,set()); model=next(iter(names)) if len(names)==1 else 'agy-enum-%s'%model_enum
                    e.put('agy', mid, ts, 'antigravity-cli-gateway', model, 'agy-cli(含网关)', usage,
                          conversation=conv, step=idx, enum=model_enum, thinking=thinking, unit='model-response', model_basis='gen-metadata' if len(names)==1 else 'enum', time_basis='completion')
                except (ValueError, TypeError, UnicodeError) as error:
                    e.issue('agy_schema_error', '%s:%s %s' % (conv, idx, error))
        finally: c.close()


def scan_dalton(e):
    for path in e.paths('dalton-db'):
        c = dbopen(path)
        try:
            # Revisions replace measurements; never sum corrections as new calls.
            sql = """SELECT u.record_json FROM observability_usage_entries u WHERE NOT EXISTS
              (SELECT 1 FROM observability_usage_entries newer WHERE newer.invocation_ref=u.invocation_ref AND newer.revision_number>u.revision_number)"""
            for raw, in c.execute(sql):
                o = json.loads(raw); ts = timestamp(o.get('occurred_at'))
                if ts is None or not e.since <= ts <= e.until: continue
                if o.get('metering_source') != 'provider_reported':
                    e.issue('dalton_non_provider_measurement', o.get('invocation_ref')); continue
                v = e.usage(o, ('input_tokens','cache_write_tokens','cache_read_tokens','output_tokens'), o.get('invocation_ref'))
                if v is not None:
                    e.put('dalton', o['invocation_ref'], ts, o.get('provider'), o.get('model'), 'dalton', v,
                          revision=o.get('revision',1), measurement=o.get('measurement_status'), unit='model-invocation', origin='dalton-db')
        finally: c.close()
    for path in e.paths('broker'):
        with open(path) as f: journal = json.load(f)
        for o in journal.get('records', []):
            r = o.get('response') or {}; ts = timestamp(o.get('createdAtMs'))
            if not r.get('ok') or ts is None or not e.since <= ts <= e.until: continue
            v = e.usage(r.get('usage'), ('inputTokens','cacheWriteTokens','cacheReadTokens','outputTokens'), o.get('invocationId'))
            if v is None: continue
            ident = 'dalton:' + o['invocationId']
            if ident in e.records:
                # Journal is a retry cache of the same invocation, not a second call.
                e.stats['dalton_journal_overlap'] += 1
                if tuple(e.records[ident]['v']) != v: e.issue('dalton_journal_usage_conflict', ident)
                continue
            e.put('dalton', o['invocationId'], ts, r.get('provider'), r.get('model'), 'dalton', v,
                  revision=0, measurement='provider-reported', unit='model-invocation', origin='broker-journal', time_basis='request-start')


def persist(e, path, hydrate=True):
    """Technical-only ledger; upsert observations, never add a previous aggregate."""
    p = Path(path).expanduser(); p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(p, timeout=30)
    os.chmod(p, 0o600)
    try:
        c.execute('CREATE TABLE IF NOT EXISTS usage_evidence (id TEXT PRIMARY KEY, ts REAL NOT NULL, payload TEXT NOT NULL)')
        c.execute('CREATE INDEX IF NOT EXISTS usage_evidence_ts ON usage_evidence(ts)')
        with c:
            c.execute('BEGIN IMMEDIATE')
            for r in e.records.values():
                prior = c.execute('SELECT payload FROM usage_evidence WHERE id=?', (r['id'],)).fetchone()
                if prior and r['kind'] == 'dalton' and json.loads(prior[0])['meta'].get('revision',0) > r['meta'].get('revision',0):
                    continue
                if prior and r['kind']=='claude':
                    old=json.loads(prior[0])
                    if tuple(old['v'])!=tuple(r['v']) and all(a>=b for a,b in zip(old['v'],r['v'])):
                        continue  # a surviving partial file cannot downgrade a stored final message
                payload=json.dumps(r,ensure_ascii=False,separators=(',',':'))
                if prior and prior[0]==payload: continue
                c.execute('INSERT INTO usage_evidence VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts,payload=excluded.payload',
                          (r['id'],r['ts'],payload))
            for payload, in c.execute('SELECT payload FROM usage_evidence WHERE ts>=? AND ts<=?', (e.since,e.until)) if hydrate else []:
                r = json.loads(payload)
                # The persisted record may carry a higher Dalton correction revision.
                e.records[r['id']] = r
        e.stats['ledger_observations'] = len(e.records)
    finally: c.close()


def summed(rows):
    return tuple(sum(r['v'][i] for r in rows) for i in range(4))


def base_model(m):
    if isinstance(m,str) and m.startswith(('gemini-','claude-','gpt-oss-')):
        for suffix in ('-low','-medium','-high','-xhigh','-max'):
            if m.endswith(suffix): return m[:-len(suffix)]
    return m


def reconcile(e):
    import usage_v3
    active = {r['id']:dict(r,meta=dict(r['meta'])) for r in e.records.values()}; held = []
    usage_v3.reconcile_compactions(e,active)
    records=list(active.values())
    codex = collections.defaultdict(list); gateways=[]; agy=collections.defaultdict(list); claude_partials=collections.defaultdict(list)
    for r in records:
        if r['kind'] in ('codex','codex-compaction'): codex[(r['meta'].get('thread'),r['meta'].get('turn'))].append(r)
        elif r['kind']=='gateway': gateways.append(r)
        elif r['kind']=='agy': agy[r['meta']['conversation']].append(r)
        elif r['kind']=='claude' and r['meta'].get('request'): claude_partials[r['meta']['request']].append(r)
    # Successful Claude aggregates replace their matching message observations;
    # when a request fails without final usage, completed messages still count.
    for g in gateways:
        if g['provider']!='claude-cli-gateway': continue
        partial=[r for r in claude_partials.get(g['meta'].get('request'),[]) if (g['meta'].get('start') or g['ts'])-1<=r['ts']<=g['ts']+1]
        for r in partial: active.pop(r['id'],None)
        if partial:
            e.stats['claude_gateway_message_reconciled']+=len(partial)
            if summed(partial)==tuple(g['v']):
                active[g['id']]['meta']['billing_parts']=[list(r['v']) for r in partial]
    enum_models=collections.defaultdict(set); used_agy=set(); mapped_gw={}
    for rows in agy.values():
        for r in rows:
            if not r['model'].startswith('agy-enum-'):enum_models[r['meta']['enum']].add(r['model'])
    for g in gateways:
        if g['provider']!='antigravity-cli-gateway': continue
        lo,hi = g['meta'].get('start'),g['ts']; candidates=[]
        if lo is not None:
            for cid, rows in agy.items():
                if g['meta'].get('conversation') and cid != g['meta']['conversation']: continue
                subset=[r for r in rows if lo-1<=r['ts']<=hi+1]
                if not subset: continue
                v=summed(subset); expected=tuple(g['v']); think=sum(r['meta'].get('thinking',0) for r in subset)
                legacy=g['meta'].get('legacy_out') and expected[3] in (v[3],v[3]+think) and expected[0] in (v[0],sum(v[:3]))
                if expected==v or legacy: candidates.append(subset)
        if len(candidates)==1 and not any(r['id'] in used_agy for r in candidates[0]):
            subset=candidates[0]; active.pop(g['id'],None); used_agy.update(r['id'] for r in subset)
            mapped_gw[g['id']]=subset
            g['meta']['replaced_by']=[r['id'] for r in subset]
            e.stats['agy_gateway_reconciled']+=1
            for r in subset:
                active[r['id']]['source']='openclaw'
                if r['model'].startswith('agy-enum-'):enum_models[r['meta']['enum']].add(base_model(g['model']))
        else:
            # A gateway request whose DB evidence overlaps in time but cannot be
            # reconciled must not be added on top of those DB observations.
            overlap = lo is not None and any(lo-1<=r['ts']<=hi+1 for rows in agy.values() for r in rows)
            if overlap:
                active.pop(g['id'],None); held.append(g); e.issue('agy_gateway_unreconciled',g['id'])
            else:
                e.issue('agy_gateway_db_missing',g['id'])
    for r in list(active.values()):
        if r['kind']=='agy' and r['model'].startswith('agy-enum-'):
            models=enum_models.get(r['meta']['enum'],set())
            if len(models)==1: r['model']=next(iter(models))
            else: e.issue('agy_model_unresolved',r['model'])
        elif r['kind']=='gateway': r['model']=base_model(r['model'])
    # Gateway response UUID embeds the logged short request UUID. Match identity
    # plus completion-time neighborhood; never match token sizes alone.
    message_covered=set()
    for r in records:
        if r['kind']!='gateway-message':continue
        response=r['meta']['response']; short=response.split('cli-',1)[-1][:8]
        matches=[g for g in gateways if g['provider']==r['provider'] and (g['meta'].get('request_uuid')==response.split('cli-',1)[-1] if g['meta'].get('request_uuid') else g['meta'].get('request','')[:8]==short) and (g['meta'].get('start',g['ts']) or g['ts'])-1<=r['ts']<=g['ts']+1]
        if len(matches)==1:
            active.pop(r['id'],None);message_covered.add(r['id']);e.stats['gateway_message_reconciled']+=1
        elif r['provider']=='claude-cli-gateway':
            message_covered.add(r['id'])
            e.stats['claude_gateway_message_fallback']+=1
        elif r['provider'] in ('antigravity-cli-gateway','muse-cli-gateway'):
            # Historical gateway messages have the old doubled-thinking output.
            active.pop(r['id'],None); held.append(r);e.issue('agy_message_without_authority',r['id'])
    for r in records:
        if r['kind']!='trajectory': continue
        m=r['meta']; thread,turn=m.get('thread'),m.get('turn')
        if thread:
            linked=codex.get((thread,turn),[])
            if linked:
                active.pop(r['id'],None)
                if summed(linked)==tuple(r['v']) or any(tuple(x['v'])==tuple(r['v']) for x in linked): e.stats['codex_trajectory_reconciled']+=1
                else: held.append(r);e.issue('codex_trajectory_usage_mismatch',r['id'])
            else: e.stats['codex_trajectory_fallback']+=1
        elif r['provider'] in ('claude-cli-gateway','antigravity-cli-gateway','muse-cli-gateway'):
            lo=m.get('start'); linked=[g for g in gateways if g['provider']==r['provider'] and lo is not None and lo-1<=g['ts']<=r['ts']+1 and (not m.get('session') or not g['meta'].get('session') or g['meta'].get('session')==m['session'].split(':run:')[0])]
            # A full run can aggregate many gateway requests. Keep the request
            # observations; don't add the enclosing run again.
            active.pop(r['id'],None)
            projected = [summed(linked)] + [tuple(g['v']) for g in linked] if linked else []
            if r['provider']=='antigravity-cli-gateway':
                for g in linked:
                    v=tuple(g['v']); think=sum(x['meta'].get('thinking',0) for x in mapped_gw.get(g['id'],[]))
                    projected.append(v[:3]+(v[3]+think,))
            covered_projection=any(v[0]==r['v'][0] and v[2:]==tuple(r['v'][2:]) for v in projected)
            if (m.get('responses') and all('gateway-message:'+resp in message_covered for resp in m['responses'])) or covered_projection:
                e.stats['gateway_trajectory_reconciled']+=1
            else:
                occupied=[x for x in active.values() if x['provider']==r['provider'] and lo is not None and lo-1<=x['ts']<=r['ts']+1]
                if r['provider']=='claude-cli-gateway' and lo is not None and not linked and not occupied:
                    active[r['id']]=r;e.stats['claude_gateway_trajectory_fallback']+=1
                else:
                    held.append(r);e.issue('gateway_trajectory_unreconciled',r['id'])
        elif r['provider']=='openai': e.stats['native_openai_restored']+=1
    usage_v3.reconcile_muse(e,active,held,gateways)
    usage_v3.reconcile_dalton(e,active,held,gateways)
    from zcode_usage import reconcile_zcode
    reconcile_zcode(e, active, held)
    return list(active.values()),held


def cached_scan(e, fn, kinds, cache_path=None):
    """Cache sanitized source observations, invalidated by inode/size/mtime + WAL.

    Archive and live SQLite scans use separate entries. Raw prompts never enter
    this cache. The ledger remains the durable authority for rotated-out evidence.
    """
    if cache_path is None:
        fn(e);return
    signature=[]
    for kind in kinds:
        for p in files(kind):
            for q in (p,p+'-wal') if p.endswith(('.sqlite','.db')) else (p,):
                try:
                    st=os.stat(q);signature.append((q,st.st_ino,st.st_size,st.st_mtime_ns))
                except FileNotFoundError:signature.append((q,None))
    code=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('zcode_usage.py').read_bytes()+Path(__file__).with_name('usage_v3.py').read_bytes()).hexdigest()
    fingerprint=digest(code,signature);key='|'.join(kinds);p=Path(cache_path).expanduser();p.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(p,timeout=30);os.chmod(p,0o600)
    try:
        c.execute('CREATE TABLE IF NOT EXISTS scan_cache (name TEXT PRIMARY KEY,fingerprint TEXT,since REAL,payload BLOB)')
        row=c.execute('SELECT fingerprint,since,payload FROM scan_cache WHERE name=?',(key,)).fetchone()
        if row and row[0]==fingerprint and row[1]<=e.since:
            data=json.loads(gzip.decompress(row[2]));e.stats['source_cache_hits']+=1
        else:
            fresh=Evidence(e.since,float('inf'));fn(fresh)
            data=dict(records=list(fresh.records.values()),stats=dict(fresh.stats),issues=dict(fresh.issues),examples=fresh.examples,inventory=fresh.inventory)
            with c:c.execute('INSERT INTO scan_cache VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET fingerprint=excluded.fingerprint,since=excluded.since,payload=excluded.payload',
                             (key,fingerprint,e.since,gzip.compress(json.dumps(data,separators=(',',':')).encode())))
        for r in data['records']:
            if e.since<=r['ts']<=e.until:
                # Source identity can also occur in the SQLite/import archive pair.
                e.put(r['kind'],r['id'].split(':',1)[1],r['ts'],r['provider'],r['model'],r['source'],r['v'],**r['meta'])
        e.stats.update(data['stats']);e.issues.update(data['issues']);e.inventory.update(data['inventory'])
        for k,v in data['examples'].items():e.examples.setdefault(k,[]).extend(v[:max(0,3-len(e.examples.get(k,[])))])
    finally:c.close()
