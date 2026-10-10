import { open, readFile, stat } from 'fs/promises'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { assets, sources } from '../db/schema'
import { assetPath } from './assets'

const languages=new Map<string,string|undefined>()
const valid=(value?:string):string|undefined=>value&&/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(value.trim())?value.trim():undefined

/** 从不可变原资产读取语言声明，不增加知识库字段，也不把个人偏好写入同步数据。 */
export async function declaredSourceLanguage(sourceId:string):Promise<string|undefined> {
  const row=getDb().select({asset:assets}).from(sources).innerJoin(assets,eq(sources.assetId,assets.id)).where(eq(sources.id,sourceId)).get()?.asset
  if(!row || !['html','htm','epub'].includes(row.ext))return undefined
  if(languages.has(row.id))return languages.get(row.id)
  let language:string|undefined
  try {
    const path=assetPath(row.id,row.ext)
    if(row.ext==='epub') {
      // 已有 EPUB 解析使用 JSZip；语言只读包内 OPF 元数据。超大书保留字符判断，避免再次加载大资产。
      if((await stat(path)).size<=64*1024*1024) {
        const JSZip=(await import('jszip')).default,zip=await JSZip.loadAsync(await readFile(path)),container=await zip.file('META-INF/container.xml')?.async('string')
        const opfPath=container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1],opf=opfPath?await zip.file(opfPath)?.async('string'):undefined
        language=valid(opf?.match(/<(?:[\w-]+:)?language\b[^>]*>\s*([^<]+)\s*<\//i)?.[1])
      }
    } else {
      const file=await open(path,'r')
      try {
        const bytes=Buffer.alloc(256*1024),{bytesRead}=await file.read(bytes,0,bytes.length,0),head=bytes.subarray(0,bytesRead).toString('utf8')
        language=valid(head.match(/<html\b[^>]*\b(?:xml:)?lang\s*=\s*["']([^"']+)["']/i)?.[1])
      } finally {await file.close()}
    }
  } catch { /* 旧资产或缺失声明沿用正文字符判定；隐私身份由调用方在读取后再校验。 */ }
  languages.set(row.id,language)
  if(languages.size>200)languages.delete(languages.keys().next().value!)
  return language
}
