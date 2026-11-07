import java.util.*;
import java.lang.reflect.*;
import java.nio.file.*;
/** Export vanilla model geometry without creating a window or OpenGL context. */
public class ExportModels {
 static Object field(Object o,String name)throws Exception {Field f;try { f=o.getClass().getDeclaredField(name); } catch(Exception e) { System.out.println(o.getClass()+" "+Arrays.toString(o.getClass().getDeclaredFields())); throw e; }f.setAccessible(true);return f.get(o);}
 static Map<String,Object> part(Object p)throws Exception {
  Map<String,Object> out=new LinkedHashMap<>();
  for(String k:new String[]{"x","y","z","xRot","yRot","zRot","xScale","yScale","zScale"})out.put(k,field(p,k));
  out.put("visible",field(p,"visible"));
  List<Object> polygons=new ArrayList<>();
  for(Object cube:(List<?>)field(p,"cubes"))for(Object poly:(Object[])field(cube,"polygons")){
   List<Object> vertices=new ArrayList<>();
   for(Object v:(Object[])field(poly,"vertices")){
    Object pos=v;
    vertices.add(List.of(field(pos,"x"),field(pos,"y"),field(pos,"z"),field(v,"u"),field(v,"v")));
   }
   Object n=field(poly,"normal");
   boolean finite=true;
   for(Object vertex:vertices) for(Object value:(List<?>)vertex) finite &= Double.isFinite(((Number)value).doubleValue());
   if(finite) polygons.add(Map.of("vertices",vertices,"normal",List.of(field(n,"x"),field(n,"y"),field(n,"z"))));
  }
  out.put("faces",polygons);Map<String,Object> children=new LinkedHashMap<>();
  for(var e:((Map<?,?>)field(p,"children")).entrySet())children.put(e.getKey().toString(),part(e.getValue()));
  out.put("children",children);return out;
 }
 public static void main(String[]args)throws Exception {
  Map<?,?> roots=(Map<?,?>)Class.forName("net.minecraft.client.model.geom.LayerDefinitions").getMethod("createRoots").invoke(null);
  Map<String,Object> out=new TreeMap<>();
  for(var entry:roots.entrySet()) {
   String key=entry.getKey().toString();
   Object root=entry.getValue().getClass().getMethod("bakeRoot").invoke(entry.getValue());
   if(key.equals("minecraft:end_crystal#main")) {
    Class<?> modelClass=Class.forName("net.minecraft.client.model.object.crystal.EndCrystalModel");
    Class<?> stateClass=Class.forName("net.minecraft.client.renderer.entity.state.EndCrystalRenderState");
    Object model=modelClass.getConstructor(root.getClass()).newInstance(root), state=stateClass.getConstructor().newInstance();
    stateClass.getField("showsBottom").setBoolean(state,true);
    modelClass.getMethod("setupAnim",stateClass).invoke(model,state);
   }
   out.put(key,part(root));
   for(String animal:new String[]{"wolf","cat","fox"})for(String age:new String[]{"","_baby"}) {
    if(!key.equals("minecraft:"+animal+age+"#main"))continue;
    String group=animal.equals("cat")?"feline":animal;
    String title=animal.substring(0,1).toUpperCase()+animal.substring(1);
    Class<?> modelClass=Class.forName("net.minecraft.client.model.animal."+group+"."+(age.isEmpty()?"Adult":"Baby")+title+"Model");
    Class<?> stateClass=Class.forName("net.minecraft.client.renderer.entity.state."+title+"RenderState");
    for(String stance:animal.equals("fox")?new String[]{"sitting","sleeping"}:new String[]{"sitting"}) {
     Object poseRoot=entry.getValue().getClass().getMethod("bakeRoot").invoke(entry.getValue());
     Object model=modelClass.getConstructor(poseRoot.getClass()).newInstance(poseRoot),state=stateClass.getConstructor().newInstance();
     stateClass.getField("ageScale").setFloat(state,age.isEmpty()?1.0f:0.5f);
     stateClass.getField("is"+stance.substring(0,1).toUpperCase()+stance.substring(1)).setBoolean(state,true);
     Method setup=Arrays.stream(modelClass.getMethods()).filter(m -> m.getName().equals("setupAnim") && m.getParameterCount()==1 && !m.isBridge() && m.getParameterTypes()[0].isAssignableFrom(stateClass)).findFirst().orElseThrow();
     setup.invoke(model,state);
     out.put(key.replace("#main","#"+stance),part(poseRoot));
    }
   }
  }
  Files.writeString(Path.of(args[0]),new com.google.gson.Gson().toJson(out));System.out.println("Exported "+out.size()+" model layers");
 }
}
