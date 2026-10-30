/** Benchmark-only synchronous SQL observation. No production API or SQL changes. */
import {performance} from 'node:perf_hooks';
const observers=new WeakMap();
export function timedSearch(graph, query, options, timing) {
  const queries=graph.queries, original=queries.db;
  let observer=observers.get(queries);if(!observer){observer={current:null};observers.set(queries,observer);}
  if(observer.current)throw Error('Nested benchmark search timing is unsupported');
  const stages={fts:{prepareMs:0,executeMs:0,calls:0},supplement:{prepareMs:0,executeMs:0,calls:0},other:{prepareMs:0,executeMs:0,calls:0}};
  const prepare=sql=>{
    const name=/\bnodes_fts\b/.test(sql)?'fts':/^SELECT \* FROM nodes WHERE (?:lower\(name\) = lower\(\?\)|name = \? COLLATE NOCASE)/.test(sql)?'supplement':'other';
    const stage=stages[name];
    let statement;const started=performance.now();
    try{statement=original.prepare(sql);}finally{stage.prepareMs+=performance.now()-started;}
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(!['all','get','run'].includes(key)||typeof value!=='function')return typeof value==='function'?value.bind(target):value;
      return (...args)=>{const active=observer.current?.[name];if(!active)return value.apply(target,args);const t=performance.now();active.calls++;try{return value.apply(target,args);}finally{active.executeMs+=performance.now()-t;}};
    }});
  };
  observer.current=stages;
  queries.db=new Proxy(original,{get(target,key){if(key==='prepare')return prepare;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  try{return graph.searchNodes(query,options);}finally{
    queries.db=original;
    observer.current=null;
    timing.searchSql=stages;
    for(const [name,value]of Object.entries(stages))timing[`search${name[0].toUpperCase()+name.slice(1)}SqlMs`]=value.prepareMs+value.executeMs;
  }
}
