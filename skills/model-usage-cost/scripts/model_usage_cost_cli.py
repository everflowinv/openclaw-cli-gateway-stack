#!/usr/bin/env python3
"""Auditable local model usage; reconciled observations, not a provider invoice."""
import argparse
import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import unittest
import usage_sources as sources
from zcode_usage import scan_zcode
from usage_v3 import scan_muse, scan_compactions

VERSION='3.0.0'
DEFAULT_CONFIG='~/.openclaw/openclaw.json'
DEFAULT_LEDGER='~/.openclaw/usage-accounting/evidence.sqlite'
DEFAULT_SPLIT=(.005,.065,.93)
NOTES=[
 '统计保留在本机的可核实用量；coverage 显示缺失、失败及无法对账的记录，不等同于云端账单。',
 'output 已包含 reasoning/thinking；cache_read/cache_write 与 fresh 分列。',
 'records 是计量记录数；model-response、gateway-request、agent-run、model-invocation 不是同一调用单位。',
 'cost_usd 是当前本地 catalog 的刊例估算，并非历史实付；缺价格的用量保留在总量，费用列单列未定价 token。',
 '本地价格表不保证历史价格、时段或长上下文档完整；费用只用于明确标注的粗估。',
 'ZCode 内建调用包括本地留存的主对话、子代理、标题、压缩和工具内部模型请求；数据库优先、rollout 补漏，未定价用量保留。',
 '按 [from,to) 统计；已关联网关使用完成时间，历史仅保留请求开始时间的记录单列。',
 '跨层关联优先 request ID；历史用量/时间一对一匹配在 coverage.stats 单列，歧义汇总不叠加。',
 'Muse 手动与网关使用相同模型的当前 Muse catalog 参考价；聚合记录缺单响应上下文时保留基础价并披露。',
]


def load_prices(path):
    with open(os.path.expanduser(path)) as f: cfg=json.load(f)
    prices={}
    for provider,entry in ((cfg.get('models') or {}).get('providers') or {}).items():
        for m in entry.get('models',[]):
            if not isinstance(m.get('cost'),dict):continue
            c=m['cost']
            try:
                rate={k:float(c.get(k,0) or 0) for k in ('input','cacheWrite','cacheRead','output')}
                if not all(math.isfinite(v) and v>=0 for v in rate.values()):raise ValueError('invalid rate')
                tiers=[]
                for tier in c.get('tieredPricing',[]):
                    bounds=tier.get('range',[])
                    if not bounds or not isinstance(bounds[0],(int,float)) or bounds[0]<0:raise ValueError('invalid tier range')
                    item={k:float(tier.get(k,rate[k])) for k in ('input','cacheWrite','cacheRead','output')}
                    if not all(math.isfinite(v) and v>=0 for v in item.values()):raise ValueError('invalid tier rate')
                    item['from']=bounds[0];tiers.append(item)
                if tiers:rate['tiers']=sorted(tiers,key=lambda x:x['from'])
                prices[(provider,m['id'])]=rate
            except (TypeError,ValueError,KeyError):raise ValueError('invalid price for %s/%s' % (provider,m.get('id')))
    if not prices:raise ValueError('no model prices in config')
    return prices


def price_for(prices,provider,model):
    pr=prices.get((provider,model))
    if pr is None and provider=='anthropic':pr=prices.get(('claude-cli-gateway',model))
    return pr


def cost_of(prices,provider,model,v,meta=None):
    pr=price_for(prices,provider,model)
    if pr is None:return None
    parts=(meta or {}).get('billing_parts')
    if parts and tuple(sum(p[i] for p in parts) for i in range(4))==tuple(v):
        return sum(cost_of(prices,provider,model,p,{'unit':'model-response'}) for p in parts)
    # Never apply a single-context threshold to a multi-response run aggregate.
    rate=pr
    if meta is None or meta.get('unit')=='model-response':
        for tier in pr.get('tiers',[]):
            if sum(v[:3])>=tier['from']:rate=tier
    return sum(v[i]*rate[k] for i,k in enumerate(('input','cacheWrite','cacheRead','output')))/1e6


def window_result(records,now,days,prices,top=0,by_model=False):
    cut=now-days*86400; groups={};total=[0]*4;known_cost=0.;unpriced_tokens=0;units=collections.Counter();estimates=0;time_estimates=0;tier_unknown=0
    for r in records:
        if not cut<=r['ts']<now:continue
        provider,model=r['provider'],r['model'];v=r['v'];c=cost_of(prices,provider,model,v,r['meta'])
        if r['meta'].get('time_basis')=='request-start':time_estimates+=1
        pr=price_for(prices,provider,model) or {}
        if pr.get('tiers') and r['meta'].get('unit')!='model-response' and not r['meta'].get('billing_parts'):tier_unknown+=1
        key=(None if by_model else r['source'],provider,model)
        b=groups.setdefault(key,dict(source=set(),provider=provider,model=model,records=0,v=[0]*4,cost_usd=0.,unpriced_tokens=0,estimated_split_records=0,units=collections.Counter()))
        b['source'].add(r['source']);b['records']+=1;b['units'][r['meta'].get('unit','unknown')]+=1
        for i in range(4):b['v'][i]+=v[i];total[i]+=v[i]
        if c is None:b['unpriced_tokens']+=sum(v);unpriced_tokens+=sum(v)
        else:b['cost_usd']+=c;known_cost+=c
        if r['meta'].get('estimated'):b['estimated_split_records']+=1;estimates+=1
        units[r['meta'].get('unit','unknown')]+=1
    rows=[]
    for b in groups.values():
        v=b.pop('v');b['source']='|'.join(sorted(b['source']));b.update(dict(zip(('fresh','cache_write','cache_read','output'),v)));b['tokens']=sum(v)
        b['priced_cost_usd']=round(b['cost_usd'],6)
        b['cost_usd']=None if b['unpriced_tokens']==b['tokens'] else b['priced_cost_usd']
        b['cost_basis']='current-catalog-estimate' if b['cost_usd'] is not None else 'unpriced'
        b['calls']=b['records'] # compatible field; units explicitly define its meaning
        b['estimated_split']=b['estimated_split_records']>0;rows.append(b)
    rows.sort(key=lambda r:(-(r['cost_usd'] if r['cost_usd'] is not None else -1),-r['tokens']))
    return dict(days=days,**{'from':dt.datetime.fromtimestamp(cut,sources.UTC).isoformat(),'to':dt.datetime.fromtimestamp(now,sources.UTC).isoformat()},
                rows=rows[:top] if top else rows,row_count=len(rows),
                totals=dict(zip(('fresh','cache_write','cache_read','output'),total),tokens=sum(total),records=sum(units.values()),units=units,
                            priced_cost_usd=round(known_cost,6),unpriced_tokens=unpriced_tokens,estimated_split_records=estimates,
                            cost_complete=unpriced_tokens==0,cost_basis='current-catalog-estimate',
                            request_start_time_records=time_estimates,tier_context_unknown_records=tier_unknown))


def gather(args):
    now=sources.timestamp(args.as_of) if args.as_of else dt.datetime.now(sources.UTC).timestamp()
    if now is None:raise ValueError('--as-of must be an ISO timestamp')
    windows=[float(w) for w in (args.days or args.windows).split(',')]
    if not windows or any(not math.isfinite(w) or w<=0 for w in windows):raise ValueError('windows must be positive finite days')
    split=tuple(float(x) for x in args.split.split(','))
    if len(split)!=3 or any(not math.isfinite(x) or x<0 for x in split) or abs(sum(split)-1)>1e-6:raise ValueError('--split needs 3 non-negative ratios summing to 1')
    cut=now-max(windows)*86400
    # Adjacent evidence resolves requests crossing a reporting boundary; final
    # output uses [cut, now), independently of scan time or ledger retention.
    e=sources.Evidence(cut-86400,now+86400 if args.as_of else now)
    if args.cmd=='collect-broker':
        sources.scan_dalton(e)
        sources.scan_agy(e)
        scan_muse(e)
        sources.scan_gateway(e,'claude-gateway',split)
        sources.scan_gateway(e,'agy-gateway',split)
    else:
        cache=None if args.no_ledger or args.no_cache else args.ledger+'.scan-cache.sqlite'
        for kind,src in [('rollout-openclaw','openclaw'),('rollout-manual','codex-cli(手动)')]:
            sources.cached_scan(e,lambda x,k=kind,s=src:sources.scan_rollouts(x,[(k,s)]),[kind],cache)
        sources.cached_scan(e,scan_compactions,['rollout-openclaw','rollout-manual'],cache)
        sources.cached_scan(e,sources.scan_claude,['claude'],cache)
        sources.scan_gateway(e,'claude-gateway',split)
        sources.scan_gateway(e,'agy-gateway',split)
        sources.cached_scan(e,lambda x:sources.scan_trajectories(x,include_files=False),['trajectory-db'],cache)
        sources.cached_scan(e,lambda x:sources.scan_trajectories(x,include_db=False),['trajectory-file'],cache)
        sources.scan_agy(e)
        scan_muse(e)
        sources.scan_dalton(e)
        sources.cached_scan(e,scan_zcode,['zcode-db','zcode-rollout'],cache)
    if not args.no_ledger:sources.persist(e,args.ledger,hydrate=args.cmd!='collect-broker')
    e.since,e.until=cut,now
    return e,sorted(set(windows))


def render(out):
    lines=[]
    for w in out['windows']:
        lines.append('%gD  %s → %s' % (w['days'],w['from'],w['to']))
        lines.append('source | provider/model | records | fresh | cacheW | cacheR | output | estimated USD')
        for r in w['rows']:
            lines.append('%s | %s/%s | %s | %s | %s | %s | %s | %s' % (r['source'],r['provider'],r['model'],r['records'],r['fresh'],r['cache_write'],r['cache_read'],r['output'], 'n/a' if r['cost_usd'] is None else '%.4f'%r['cost_usd']))
        t=w['totals'];lines.append('TOTAL (all %d rows): %s tokens, priced estimate $%.4f, unpriced %s tokens' % (w['row_count'],t['tokens'],t['priced_cost_usd'],t['unpriced_tokens']))
        lines.append('')
    lines.append('Coverage: %s; %d unresolved aggregate observations excluded (may overlap counted records).' % (out['coverage']['status'],out['coverage']['unresolved_aggregate_records']))
    for k,v in out['coverage']['issues'].items():lines.append('! %s: %s' % (k,v))
    lines.extend(NOTES)
    return '\n'.join(lines)


def command(args):
    if args.cmd=='prices':
        prices=load_prices(args.config);out={'ok':True,'version':VERSION,'basis':'current-catalog-estimate','prices':{p+'/'+m:c for (p,m),c in sorted(prices.items())}}
    elif args.cmd=='self-test':
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern='test*.py')
        import io
        stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
        out={'ok':result.wasSuccessful() and result.testsRun>0,'version':VERSION,'tests_run':result.testsRun,'detail':stream.getvalue(),
             'hint':'self-test validates accounting fixtures; run summary to inspect actual source coverage'}
    else:
        e,windows=gather(args)
        if args.cmd=='collect-broker':
            out={'ok':True,'version':VERSION,'observations':len(e.records),'issues':dict(e.issues),'inventory':e.inventory}
        else:
            prices=load_prices(args.config);records,held=sources.reconcile(e)
            records=[r for r in records if e.since<=r['ts']<e.until]
            held=[r for r in held if e.since<=r['ts']<e.until]
            out={'ok':True,'version':VERSION,'generated_at':dt.datetime.fromtimestamp(e.until,sources.UTC).isoformat(),
                 'windows':[window_result(records,e.until,w,prices,args.top,args.by_model) for w in windows],
                 'coverage':{'status':'partial' if e.issues or held or any(v==0 for v in e.inventory.values()) else 'local-observations-only',
                             'complete':False,'inventory':e.inventory,'issues':dict(sorted(e.issues.items())),
                             'examples':e.examples,'stats':dict(e.stats),'unresolved_aggregate_records':len(held),
                             'unresolved_aggregate_tokens_not_additive':sum(sum(r['v']) for r in held)},'notes':NOTES}
            if args.audit_records:
                target=Path(args.audit_records).expanduser();target.parent.mkdir(parents=True,exist_ok=True)
                target.write_text(json.dumps({'included':records,'unresolved':held},ensure_ascii=False,separators=(',',':')));os.chmod(target,0o600)
    print(json.dumps(out,ensure_ascii=False,indent=1) if args.json or args.cmd!='summary' else render(out))
    return 0 if out['ok'] else 1


def main():
    p=argparse.ArgumentParser(description='Reconciled local model usage and explicitly estimated cost')
    p.add_argument('--version',action='version',version=VERSION)
    p.add_argument('--config',default=DEFAULT_CONFIG)
    sub=p.add_subparsers(dest='cmd')
    for name in ('summary','collect-broker'):
        s=sub.add_parser(name);s.add_argument('--windows',default='1,7,30');s.add_argument('--days');s.add_argument('--as-of');s.add_argument('--split',default=','.join(map(str,DEFAULT_SPLIT)))
        s.add_argument('--ledger',default=DEFAULT_LEDGER);s.add_argument('--no-ledger',action='store_true');s.add_argument('--no-cache',action='store_true');s.add_argument('--top',type=int,default=0);s.add_argument('--by-model',action='store_true');s.add_argument('--audit-records')
    sub.add_parser('prices');sub.add_parser('self-test')
    argv=[a for a in sys.argv[1:] if a!='--json'];use_json='--json' in sys.argv
    if not argv or (not any(a in argv for a in ('summary','prices','self-test','collect-broker','--help','-h','--version'))):argv+=['summary']
    args=p.parse_args(argv);args.json=use_json
    if getattr(args,'top',0)<0:raise ValueError('--top must be non-negative')
    return command(args)

if __name__=='__main__':
    try:sys.exit(main())
    except BrokenPipeError:sys.exit(0)
    except (OSError,ValueError,sqlite3.Error,KeyError,TypeError) as error:
        print(json.dumps({'ok':False,'error':str(error),'hint':'Check source readability/schema and CLI arguments. A failed source is not a successful zero-usage report.'},ensure_ascii=False));sys.exit(1)
