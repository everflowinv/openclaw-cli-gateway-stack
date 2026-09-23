"""Exercise the real HTML/SSE viewer with synthetic, non-private gateway logs."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--browser-executable', required=True)
parser.add_argument('--screenshot', required=True)
args = parser.parse_args()
here = Path(__file__).resolve().parent
def usage(inp=1000, out=100, cached=500):
    return {'prompt_tokens': inp, 'completion_tokens': out, 'total_tokens': inp+out, 'prompt_tokens_details': {'cached_tokens': cached}, 'completion_tokens_details': {'reasoning_tokens': 20}}
def line(prefix, request, event, **fields):
    return f'[{prefix}] ' + json.dumps({'request': request, 'event': event, **fields})+'\n'

with tempfile.TemporaryDirectory(prefix='muse-dashboard-test-') as directory:
    root = Path(directory)
    files = [root/(name+'-cli-gateway.stdout.log') for name in ['claude', 'antigravity', 'muse']]
    files[0].write_text(line('CLIGW', 'claude-one', 'start', model='claude-fable-5')+line('CLIGW','claude-one','text',text='CLAUDE_FIXTURE')+line('CLIGW','claude-one','done',usage=usage(),durationMs=5000))
    files[1].write_text(line('AGYGW','agy-one','start',model='gemini-3.8-flash')+line('AGYGW','agy-one','done',usage=usage(),durationMs=6000))
    muse=''
    for req,model,cost in [('standard','muse-spark-1.3',.001125),('contributor','muse-spark-1.3-contributor',.000071)]:
        muse += line('MUSEGW', req, 'start', model=model, effort='high',contextWindow=384000,maxPromptBytes=1400000)
        muse += line('MUSEGW', req, 'usage', usage=usage(), estimatedCostUsd=cost, coverage={'includesBackground':True}, backgroundUsage=usage(100,20,0),inputIntegrity={'verified':True})
        muse += line('MUSEGW', req, 'done', usage=usage(),estimatedCostUsd=cost,durationMs=12000)
    muse += line('MUSEGW','failed','start',model='muse-spark-1.3')+line('MUSEGW','failed','error',message='synthetic context rejection',code='MUSE_INPUT_NOT_PRESERVED')
    muse += line('MUSEGW','running','start',model='muse-spark-1.3')
    files[2].write_text(muse)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    command=[sys.executable,str(here/'server.py'),'--port',str(port)]
    for file in files:command += ['--file',str(file)]
    process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/sources',timeout=1).close();break
            except Exception:time.sleep(.05)
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path=args.browser_executable)
            page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
            errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{port}/#muse-cli-gateway')
            page.wait_for_function("document.querySelector('#metric-requests').textContent === '4'")
            assert page.locator('.tab').all_text_contents()==['Claude CLI','Antigravity CLI','Muse Code']
            assert page.locator('#metric-tokens').inner_text()=='2,200'
            assert page.locator('#metric-cost').inner_text()=='$0.001196'
            assert page.locator('#metric-coverage').inner_text()=='2 / 3'
            assert page.locator('#metric-running').inner_text()=='1 / 1'
            assert '384,000' in page.locator('#model-summary').inner_text()
            page.locator('.model-pill').filter(has_text='contributor').click()
            assert 'contributor' in page.locator('#filter').input_value()
            assert page.locator('.log-container.active .item:not(.hidden)').count()>0
            page.get_by_text('重置筛选',exact=True).click()
            page.get_by_text('跟随日志',exact=True).click()
            assert 'active' not in (page.locator('#btn-follow').get_attribute('class') or '')
            page.get_by_text('跟随日志',exact=True).click()
            with page.expect_download() as event:page.get_by_text('下载日志',exact=True).click()
            download=event.value
            assert 'muse-cli-gateway' in download.suggested_filename
            page.get_by_role('button',name='Claude CLI',exact=True).click()
            assert page.locator('#metric-tokens').inner_text()=='1,100'
            page.get_by_role('button',name='Muse Code',exact=True).click()
            assert page.locator('#metric-tokens').inner_text()=='2,200'
            page.screenshot(path=args.screenshot,full_page=True)
            page.get_by_text('清空视图',exact=True).click()
            assert page.locator('#metric-requests').inner_text()=='0'
            with files[2].open('a') as f:
                f.write(line('MUSEGW','after-clear','start',model='muse-spark-1.3'))
                f.write(line('MUSEGW','after-clear','done',usage=usage(),estimatedCostUsd=.001125,durationMs=20))
            page.wait_for_function("document.querySelector('#metric-tokens').textContent === '1,100'")
            for _ in range(3):
                page.get_by_role('button',name='Antigravity CLI',exact=True).click()
                page.get_by_role('button',name='Muse Code',exact=True).click()
            assert not errors,errors
            browser.close()
        print(json.dumps({'ok':True,'checks':['three-tabs','deduplicated-usage','list-price-cost','unknown-coverage','model-filter','reset-filter','follow','download','clear','live-SSE-after-clear','repeated-tab-switch'],'pageErrors':errors}))
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
