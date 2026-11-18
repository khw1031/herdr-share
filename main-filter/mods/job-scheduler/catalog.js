// Read-only catalogs from each app's saved state. Never copy jobs into the local scheduler.
import { exec, machines } from "herdr";
export const CATALOG_REFRESH_MS = 60_000;
const reader = `import datetime as d,json,os,pathlib,socket
p=pathlib.Path(os.environ.get('HERDR_APP_HOME',os.path.expanduser('~/.config/herdr-app')))/'shared.json'
if not p.is_file(): raise SystemExit('Herdr shared state file not found: '+str(p))
s=json.loads(p.read_text()); jobs=s.get('job-scheduler/jobs',[])
if not isinstance(jobs,list): raise SystemExit('Invalid scheduler jobs: expected array')
now=d.datetime.now().astimezone()
out=[]
for j in jobs:
 if not isinstance(j,dict) or not isinstance(j.get('id'),str) or not isinstance(j.get('time'),str): raise SystemExit('Invalid saved job')
 next_at=None
 if j.get('enabled') and not j.get('done'):
  h,m=map(int,j['time'].split(':'))
  if j.get('type')=='once':
   when=d.datetime.fromisoformat(j['date']+'T'+j['time']).astimezone()
   if when>now: next_at=when
  else:
   for ahead in range(8):
    day=now.date()+d.timedelta(days=ahead)
    when=d.datetime.combine(day,d.time(h,m)).astimezone()
    if when>now and (when.weekday()+1)%7 in j.get('days',[]): next_at=when; break
 item={k:j.get(k) for k in ['id','name','machine','type','time','days','date','mode','folder','agent','enabled','done','lastRunAt']}
 item['task']=str(j.get('task',''))[:240]
 item['nextRunAt']=int(next_at.timestamp()*1000) if next_at else None
 item['nextRunText']=next_at.strftime('%m.%d %H:%M %Z') if next_at else '-'
 out.append(item)
print(json.dumps({'host':socket.gethostname(),'savedAt':int(p.stat().st_mtime*1000),'jobs':out},ensure_ascii=False))`;

export async function readCatalog(machine) {
  try {
    const response=await exec("python3",["-c",reader],{on:machine,timeout:15000});
    if(response.code !== 0) throw new Error(response.stderr.trim() || response.stdout.trim() || `exit ${response.code}`);
    const data=JSON.parse(response.stdout);
    if(!Array.isArray(data.jobs)) throw new Error("invalid catalog response");
    return {...data,owner:machine,readAt:Date.now(),error:null};
  } catch(error) { return {owner:machine,error:String(error?.message ?? error),readAt:Date.now(),jobs:null}; }
}

export async function readAllCatalogs() {
  return Promise.all(machines().filter(m=>m.name).map(m=>readCatalog(m.name)));
}
