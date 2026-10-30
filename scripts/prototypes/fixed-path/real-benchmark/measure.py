import os,sys,time,json,subprocess,threading,pathlib
root,out=sys.argv[1:3]; cmd=sys.argv[3:];f=open(out+'.log','w'); p=subprocess.Popen(cmd,stdout=f,stderr=subprocess.STDOUT);samples=[]
def tree(pid):
 # This executor exposes /proc/status but not task/*/children. Discover PPid.
 parents={}
 for entry in pathlib.Path('/proc').iterdir():
  if not entry.name.isdigit():continue
  try:
   fields=dict(line.split(':',1) for line in (entry/'status').read_text().splitlines() if ':' in line)
   parents[int(entry.name)]=int(fields['PPid'])
  except (OSError,ValueError,KeyError):pass
 found={pid}
 while True:
  more={child for child,parent in parents.items() if parent in found}
  if more<=found:return list(found)
  found|=more
def size():
 n=a=0
 for d,_,files in os.walk(os.path.join(root,'.codegraph-wx')):
  for fn in files:
   try:s=os.stat(os.path.join(d,fn));n+=s.st_size;a+=s.st_blocks*512
   except OSError:pass
 return n,a
while p.poll() is None:
 rss=cpu=readb=writeb=0
 for pid in tree(p.pid):
  try:
   s=pathlib.Path(f'/proc/{pid}/stat').read_text().split();cpu+=int(s[13])+int(s[14]);rss+=int(s[23])*os.sysconf('SC_PAGE_SIZE');io=dict(x.split(': ') for x in pathlib.Path(f'/proc/{pid}/io').read_text().splitlines());readb+=int(io['read_bytes']);writeb+=int(io['write_bytes'])
  except (OSError,ValueError,IndexError):pass
 logical,allocated=size();samples.append({'at':time.time(),'rssBytes':rss,'cpuTicks':cpu,'readBytes':readb,'writeBytes':writeb,'logicalDiskBytes':logical,'allocatedDiskBytes':allocated});
 if len(samples)%4==0:json.dump(samples[-1],open(out+'.live.json','w'))
 time.sleep(.5)
f.close();json.dump({'processDiscovery':'/proc/status PPid traversal','command':cmd,'returncode':p.returncode,'sampleIntervalMs':500,'clockTicksPerSecond':os.sysconf('SC_CLK_TCK'),'peakRssBytes':max((s['rssBytes'] for s in samples),default=0),'peakDiskBytes':max((s['logicalDiskBytes'] for s in samples),default=0),'peakAllocatedDiskBytes':max((s['allocatedDiskBytes'] for s in samples),default=0),'samples':samples},open(out+'.resources.json','w'),indent=2);sys.exit(p.returncode)
