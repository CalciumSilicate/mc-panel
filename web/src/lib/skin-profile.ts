import { array, object, string } from './entity-geometry'

export function skinProfile(raw:unknown):{hash?:string;slim?:boolean} {
  const profile=object(raw),properties=profile.properties??profile.Properties
  const list=Array.isArray(properties)?properties:array(object(properties).textures)
  const entry=object(list.find(v=>!object(v).name||object(v).name==='textures'))
  try {
    const encoded=string(entry.value??entry.Value)
    const data=encoded?object(JSON.parse(atob(encoded))):profile
    const skin=object(object(data.textures).SKIN)
    const url=new URL(string(skin.url))
    if(url.hostname!=='textures.minecraft.net'||!['https:','http:'].includes(url.protocol))return {}
    const hash=/^\/texture\/([a-f0-9]{32,64})$/.exec(url.pathname)?.[1]
    return {hash,slim:object(skin.metadata).model==='slim'}
  } catch{return {}}
}
