import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { lensFilterSQL, lensKeywordSQL, lensVectorSQL } from '../lensRetrieval'

describe('recording retrieval filters execute before rank and limit', () => {
  it('uses bound parameters even for hostile person identifiers', () => {
    const filter = lensFilterSQL({ personId: "p' OR 1=1--" })
    expect(filter.sql).not.toContain("p' OR")
    expect(filter.params).toEqual(["p' OR 1=1--"])
  })
  it('combines person/scene/series/date and excludes private/deleted sources for FTS and real sqlite-vec', () => {
    const filters = { personId: 'p1', scene: 'meeting' as const, seriesId: 'series1', from: '2026-10-09', to: '2026-10-10' },
      kw = lensKeywordSQL(filters),
      vec = lensVectorSQL(filters)
    const script = `
      const Database=require('better-sqlite3'),db=new Database(':memory:');db.loadExtension(require('sqlite-vec').getLoadablePath());
      db.exec(\`CREATE TABLE sources(id TEXT PRIMARY KEY,deleted_at INTEGER,ai_excluded INTEGER,accessed_at INTEGER);
        CREATE TABLE recordings(id TEXT,source_id TEXT,deleted_at INTEGER,scene TEXT,series_id TEXT,started_at INTEGER);
        CREATE TABLE source_segments(id TEXT PRIMARY KEY,source_id TEXT,kind TEXT,locator TEXT);
        CREATE VIRTUAL TABLE segments_fts USING fts5(segment_id UNINDEXED,text,tokenize='trigram');
        CREATE TABLE chunks(rowid INTEGER PRIMARY KEY,owner_type TEXT,owner_id TEXT);
        CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[2] distance_metric=cosine);\`);
      let seq=0;
      const insert=(id,overrides={},cosine=1)=>{
        const r={person:'p1',scene:'meeting',series:'series1',date:'2026-10-10T12:00:00',excluded:0,deleted:null,recordDeleted:null,...overrides},at=Date.parse(r.date),row=++seq;
        db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(id,r.deleted,r.excluded,at);
        db.prepare('INSERT INTO recordings VALUES(?,?,?,?,?,?)').run(id,id,r.recordDeleted,r.scene,r.series,at);
        db.prepare('INSERT INTO source_segments VALUES(?,?,?,?)').run(id,id,'transcript',JSON.stringify({personId:r.person}));
        db.prepare('INSERT INTO segments_fts VALUES(?,?)').run(id,'预算审批讨论');
        db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(row,'segment',id);
        db.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(BigInt(row),Buffer.from(new Float32Array([cosine,Math.sqrt(1-cosine*cosine)]).buffer));
      };
      for(let i=0;i<60;i++) insert('wrong-'+i,{person:'p2'});
      insert('private',{excluded:1});insert('deleted',{deleted:1});insert('deleted-record',{recordDeleted:1});
      insert('lecture',{scene:'lecture'});insert('other-series',{series:'series2'});insert('old',{date:'2026-10-08T12:00:00'});insert('future',{date:'2026-10-11T12:00:00'});
      insert('valid',{},0.8);
      const keywords=db.prepare(${JSON.stringify(kw.sql)}).all('"预算审批"',...${JSON.stringify(kw.params)},1).map(r=>r.segment_id);
      const vectors=db.prepare(${JSON.stringify(vec.sql)}).all(Buffer.from(new Float32Array([1,0]).buffer),...${JSON.stringify(vec.params)},1).map(r=>db.prepare('SELECT owner_id FROM chunks WHERE rowid=?').get(r.rowid).owner_id);
      process.stdout.write(JSON.stringify({keywords,vectors}));db.close();`
    const electronPath = createRequire(import.meta.url)('electron') as string
    const result = JSON.parse(
      execFileSync(electronPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    ) as { keywords: string[]; vectors: string[] }
    expect(result).toEqual({ keywords: ['valid'], vectors: ['valid'] })
  })
})
