#!/usr/bin/env python3
"""Harvest the bounded Dalton broker retry journal without invoking a model."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile

state=Path.home()/'.openclaw/usage-accounting'
state.mkdir(parents=True,exist_ok=True)
runner=Path.home()/'.openclaw/agents/main/agent/workshop-skills/model-usage-cost/scripts/run.sh'
try:
    python=runner.parent.parent/'venv/bin/python'
    command=[str(python),str(runner.parent/'model_usage_cost_cli.py'),'collect-broker','--json'] if python.exists() else ['/bin/bash',str(runner),'collect-broker','--json']
    result=subprocess.run(command,capture_output=True,text=True,timeout=50)
    try: status=json.loads(result.stdout)
    except ValueError: status={'ok':False,'error':'collector did not return JSON','hint':'Run model-usage-cost collect-broker --json manually.'}
    code=result.returncode
    if code and status.get('ok'):status['ok']=False
except (OSError,subprocess.TimeoutExpired) as error:
    status={'ok':False,'error':str(error),'hint':'Check skill installation and local SQLite locks.'};code=1
status['collected_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
fd,temp=tempfile.mkstemp(prefix='.collector-status-',dir=state)
with os.fdopen(fd,'w') as f:json.dump(status,f,ensure_ascii=False,indent=1)
os.replace(temp,state/'collector-status.json')
raise SystemExit(code)
