from pathlib import Path
import json,shutil
D=Path('/workspace/codegraph-evidence/shared-snapshot');E=D.parent;R=Path('/workspace/codegraph-regression-fixes');out=R/'validation/release-1.1.2-20261018/shared-snapshot';out.mkdir(exist_ok=True);s=json.loads((D/'summary.json').read_text())
t='''共同物理快照三对隔离实验（产品冻结594c45f）

设计和范围
使用合法持有RocksDB源码及既有30d数据库；源库只读SQLite backup到隔离项目，将crc32c.cc恢复原始字节后，通过正常30d sync撤销之前104字节探针。未手改任何图行、未新建init。检查107724节点、无probe、stamp36、complete、integrity_check=ok，CLI退出后再SQLite backup保存template.db。
三对顺序AB/BA/AB，A=30d，B=594。每次恢复同一模板字节到同一路径，再写入原实验完全相同104字节变更；固定Node、依赖、helpers、workers、堆和native配置。恢复/哈希/结果图读取均在计时外。无热身剔除，无追加样本。所有6次正常退出。
'''
t+='快照SHA256：'+s['manifest']['templateSha256']+'\n快照字节数：'+str(s['manifest']['templateBytes'])+'\n物理快照保存在/workspace/codegraph-evidence/shared-snapshot/template.db，不装入Git或小型证据包。\n'
t+='''
计量方法
通过相同外部--require诊断脚本记录SQLite adapter prepare/run/get/all/iterate.next/exec/pragma耗时与调用区间process.cpuUsage；不改src/dist、不新增生产功能或开关。CPU总量使用Python RUSAGE_CHILDREN每次命令前后差，包含已等待的CLI及其子进程CPU；Node worker线程包含在进程CPU中。CPU可能大于wall。
SQL CPU是调用区间整个Node进程的CPU，不是SQLite专属CPU；并发线程也可能计入。逐操作计时本身有开销，六次使用相同脚本且操作数量一致；本组绝对值不能与未插桩旧矩阵直接混算。
orphanAndSynthesisMs引用生产日志细分计时；预留的synthesizeIncrementalCCpp方法hook本组没有记录调用，不能把空记录当作该尾阶段耗时为0，也不能声称测到了其专属CPU。SQL列为全命令adapter区间汇总，包含准备和迭代步，不与尾阶段相加。

全部原值（wall/CPU秒；尾阶段与SQL毫秒）
'''
for r in s['runs']:t+=f"{r['label']}: wall={r['wallSeconds']:.6f}; CPU user={r['cpuUserSeconds']:.6f}, system={r['cpuSystemSeconds']:.6f}, total={r['cpuSeconds']:.6f}; orphanAndSynthesis={r['tailMs']['orphanAndSynthesisMs']}; SQL wall={r['sqlWallMs']:.3f}, SQL区间进程CPU={r['sqlCpuMs']:.3f}\n"
t+='\n逐对变化：\n'
for p in s['pairs']:t+=f"r{p['pair']}: wall {p['wallChangePercent']:+.3f}%, CPU {p['cpuChangePercent']:+.3f}%\n"
for k,v in s['medians'].items():t+=f"中位{k}: {v['baseline']:.6f}→{v['fixed']:.6f} ({v['changePercent']:+.3f}%)\n"
t+='''
SQL工作量与图
六次SQL文本/操作类型/阶段分组及次数完全相同，共416006个adapter操作（包含iterate.next，绝不是416006条独立SQL）。最大的操作包括：按kind迭代nodes的231517个next、按id查nodes的125371次get、按source/kind查edges的23388次all。逐SQL原文/次数/wall/CPU在每次profile中保留。
六次最终nodes/edges完整排序逻辑哈希完全相同，节点去updated_at，边去自增id。每次只改1文件、无recoveryRetryFiles、SQLite完整性正常；核心代码不变。输出107726节点、407791边，与原30d修改后图相符。
'''
for k in ['nodes','edges']:t+=k+' SHA256：'+s['runs'][0]['graph'][k]['sha256']+'\n'
t+='''
结论
在共同物理起点上，原+8.10%没有作为稳定方向复现：wall三对+10.13%、+1.29%、-4.30%，中位+1.29%；CPU三对+11.80%、+3.20%、-4.86%，中位+3.20%。第一对的不利wall和CPU完整保留，SQL区间进程CPU中位也仍为+7.22%，不淡化这些数字。
结合先前目标文件身份函数零调用、构建只差身份模块、此次共同DB和一致SQL工作量，未发现稳定的、由新增身份代码直接导致的端到端约8%退化。三对不是等价性检验，不能承诺绝对零成本或所有环境无回归，也不能声称全部剩余差值已归因于某一种噪声。
共同起点是30d图，未变的crc32c_test.cc不会重索引，因此八条额外声明在两版都保留。本组隔离代码版本，不能排除新修复图/不同布局的间接影响。没有手改DB构造八条逻辑差异控制组，也没有将另一历史候选库冒充594图。本轮不追加实验，不重构或优化产品。
13项共有失败仍仅列基线，非新增阻断。正式全平台包缺Windows产物的边界不变。仅本地证据提交，无push/merge/release。
'''
(D/'REPORT.zh-CN.txt').write_text(t);(E/'REPORT.shared-snapshot.zh-CN.txt').write_text(t)
for p in D.iterdir():
 if p.is_file()and p.suffix in ['.json','.cjs','.py','.txt','.log']:shutil.copy2(p,out/p.name)
main=out.parent/'REPORT.zh-CN.txt';main.write_text('最新补充：shared-snapshot/REPORT.zh-CN.txt记录共同物理起点三对隔离结果；产品仍594c45f，未发现稳定复现的约8%直接代码退化，不承诺零成本或所有场景等价。\n\n'+main.read_text())
p=out.parent/'results.json';x=json.loads(p.read_text());x['sharedSnapshotIsolation']={'pairs':s['pairs'],'medians':s['medians'],'snapshotSha256':s['manifest']['templateSha256'],'graphEqual':True,'sqlWorkloadEqual':True,'report':'shared-snapshot/REPORT.zh-CN.txt','scope':'same 30d physical graph; repaired-eight-declaration graph not isolated'};p.write_text(json.dumps(x,ensure_ascii=False,indent=2))
print('Prepared shared-snapshot report and evidence')
