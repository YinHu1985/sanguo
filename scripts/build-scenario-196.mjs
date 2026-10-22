import { readFile, writeFile } from "node:fs/promises";

// This is the authoring source for the local scenario. Positions and routes remain
// in strategic-atlas.json. Values below are game balance, not historical censuses.
const root = new URL("../", import.meta.url);
const atlas = JSON.parse(await readFile(new URL("src/data/strategic-atlas.json", root), "utf8"));
const factions = [
  ["liu-bei", "刘备军", "liu-bei", "xiaopei", "#bd503a", "寄寓小沛，关张勇将与徐州旧臣相随。地狭兵少，须先安民积粮。"],
  ["cao-cao", "曹操军", "cao-cao", "xuchang", "#3c7065", "迎天子于许，屯田初兴，兖豫诸郡渐定。文武济济，但四面仍有强敌。"],
  ["yuan-shao", "袁绍军", "yuan-shao", "ye", "#b89443", "雄踞河北，青州新附，谋臣猛将云集。北方尚有公孙氏与黑山军。"],
  ["lu-bu", "吕布军", "lu-bu", "xuzhou", "#9c55a8", "乘虚取得下邳，与刘备、袁术周旋。兼辖泰山诸将，诸部并非铁板一块。"],
  ["yuan-shu", "袁术军", "yuan-shu", "shouchun", "#b67d46", "坐拥淮南，财粮仍丰而民心不稳。与孙策名义关系复杂，本剧本分别操作。"],
  ["sun-ce", "孙策军", "sun-ce", "wu", "#c56945", "渡江破敌，进取吴会，江东基业初立。旧部与江东士人共谋进取。"],
  ["liu-yao", "刘繇军", "liu-yao", "yuzhang", "#5e8999", "退守豫章，招集旧部。与华歆及当地郡府合为一个可操作阵营。"],
  ["liu-biao", "刘表军", "liu-biao", "xiangyang", "#6478ad", "荆襄承平，士人来归，疆土广阔。北有宛城屏障，东临孙氏新军。"],
  ["liu-zhang", "刘璋军", "liu-zhang", "chengdu", "#6a9861", "承父业领益州，巴蜀富庶而南中遥远。东州士与本地豪族尚待调和。"],
  ["zhang-lu", "张鲁军", "zhang-lu", "hanzhong", "#8c79ac", "据汉中，凭山川与教团聚众。武都边郡按汉中影响范围作游戏归并。"],
  ["zhang-xiu", "张绣军", "zhang-xiu", "wan", "#b06470", "张济死后领其部曲，屯南阳而与刘表相结。以宛城为进退支点。"],
  ["ma-teng", "马腾军", "ma-teng", "tianshui", "#ba915e", "凉州强兵之一，马氏宗族与西州豪杰相聚。陇右归属按势力影响概括。"],
  ["han-sui", "韩遂军", "han-sui", "jincheng", "#8a9959", "经营金城，联结西州诸部。部曲与诸将各有根基，宜整军修好。"],
  ["li-jue", "李傕余部", "li-jue", "changan", "#8b5960", "天子已东归，关中残破。李傕、郭汜等西凉余部为可玩性合并，非稳定同盟。"],
  ["duan-wei", "段煨军", "duan-wei", "hongnong", "#9d8064", "守弘农，抚民耕作，在关中诸军之间保全地方。"],
  ["zhang-yang", "张杨军", "zhang-yang", "henei", "#778baa", "据河内，曾助天子修缮洛阳宫室。夹在河北与曹操之间。"],
  ["zhang-yan", "黑山军", "zhang-yan", "changshan", "#727b68", "依太行诸山自保。以常山表示山地活动区，并非完整占据该郡。"],
  ["gongsun-zan", "公孙瓒军", "gongsun-zan", "beiping", "#c2bda0", "与袁绍多年相争，仍有白马骑士与幽州旧部。易京据点并入中山节点。"],
  ["gongsun-du", "公孙度军", "gongsun-du", "xiangping", "#8b97bb", "割据辽东，招纳流寓，经营边郡。可凭辽海避中原锋镝。"],
  ["xianyu-fu", "幽州联军", "xianyu-fu", "ji", "#78a39b", "刘虞旧部与地方首领结盟抗瓒。鲜于辅领衔，诸部合并为可操作阵营。"],
  ["huchuquan", "南匈奴诸部", "huchuquan", "yunzhong", "#a28b65", "南匈奴与北边诸部的游戏合并势力。云中、雁门表示活动区，非精确郡县占领。"],
  ["hexi-offices", "河西郡府", "yin-feng", "dunhuang", "#a89972", "河西诸郡隔绝而各有官吏。以敦煌太守尹奉为操作代表合并地方郡府，并非史实上的统一割据集团。"],
  ["wang-yi", "河东郡府", "wang-yi", "hedong", "#967e90", "王邑领河东，曾供给东归朝廷。以地方郡府独立经营，面对诸强求存。"],
  ["shi-xie", "士燮军", "shi-xie", "jiaozhi", "#6f9a89", "士氏居交趾，重教化而纳流寓。兄弟暂同居交趾，不提前套用后来分领诸郡的局面。"],
  ["zhu-fu", "交州刺史府", "zhu-fu", "cangwu", "#789daa", "朱符名义领交州，岭南郡县多靠当地官吏维系。本剧本与士氏交趾分开操作。"]
].map(([id, name, lord, capitalId, color, description]) => ({ id, name, lord, capitalId, color, accent: "#f1deb4", description, playable: true }));

// Entries: city|faction|governor. An omitted governor remains vacant. Cities
// omitted entirely stay neutral; ownership and garrisons do not require staff.
const ownership = `
dunhuang|hexi-offices|yin-feng
jiuquan|hexi-offices|huang-yan
zhangye|hexi-offices|zhang-meng
wuwei|han-sui|cheng-gongying
jincheng|han-sui|han-sui
xiping|han-sui|yan-xing
longxi|ma-teng|pang-de
tianshui|ma-teng|ma-teng
anding|ma-teng|ma-chao
changan|li-jue|li-jue
yunzhong|huchuquan|huchuquan
yanmen|huchuquan|qu-bei
daijun|xianyu-fu|xianyu-yin
jinyang|yuan-shao|gao-gan
shangdang|yuan-shao|guo-yuan
hedong|wang-yi|wang-yi
hongnong|duan-wei|duan-wei
ji|xianyu-fu|xianyu-fu
beiping|gongsun-zan|gongsun-zan
liaoxi|xianyu-fu|tadun
xiangping|gongsun-du|gongsun-du
xuantu|gongsun-du|gongsun-gong
zhongshan|gongsun-zan|tian-kai
changshan|zhang-yan|zhang-yan
julu|yuan-shao|zhang-he
ganling|yuan-shao|ju-yi
ye|yuan-shao|yuan-shao
nanpi|yuan-shao|yuan-xi
pingyuan|yuan-shao|gao-lan
beihai|yuan-shao|yuan-tan
donglai|yuan-shao|wang-xiu
linzi|yuan-shao|xin-ping
jibei|cao-cao|
taishan|lu-bu|sun-guan
langya|lu-bu|zang-ba
henei|zhang-yang|zhang-yang
luoyang|cao-cao|dong-zhao
chenliu|cao-cao|
puyang|cao-cao|xiahou-dun
xuchang|cao-cao|cao-cao
runan|cao-cao|li-tong
qiao|cao-cao|cao-ren
xiaopei|liu-bei|liu-bei
pengcheng|lu-bu|zhang-liao
xuzhou|lu-bu|lu-bu
shouchun|yuan-shu|yuan-shu
guangling|lu-bu|chen-deng
lujiang|yuan-shu|liu-xun
jianye|sun-ce|cheng-pu
wu|sun-ce|sun-ce
kuaiji|sun-ce|sun-jing
yuzhang|liu-yao|liu-yao
jianan|sun-ce|han-dang
luling|liu-yao|hua-xin
wan|zhang-xiu|zhang-xiu
xinye|liu-biao|wen-pin
xiangyang|liu-biao|liu-biao
shangyong|liu-biao|shen-dan
jiangxia|liu-biao|huang-zu
jiangling|liu-biao|cai-mao
wuling|liu-biao|jin-xuan
changsha|liu-biao|han-xuan
guiyang|liu-biao|zhao-fan
lingling|liu-biao|liu-du
wudu|zhang-lu|yang-ang
hanzhong|zhang-lu|zhang-lu
zitong|liu-zhang|zhang-ren
chengdu|liu-zhang|liu-zhang
jiangzhou|liu-zhang|yan-yan
yongan|liu-zhang|liu-kui
yuexi|liu-zhang|jiao-huang
zangke|liu-zhang|dong-he
jianning|liu-zhang|yong-kai
yongchang|liu-zhang|lv-kai
yunnan|liu-zhang|
nanhai|zhu-fu|
cangwu|zhu-fu|zhu-fu
yulin|zhu-fu|
hepu|zhu-fu|
jiaozhi|shi-xie|shi-xie
chaisang|liu-yao|
`.trim().split("\n").map((line) => line.split("|"));

const officers = [];
const biographies = {};
const residentIds = new Map(atlas.cities.map((city) => [city.id, []]));
const ownershipByCity = new Map(ownership.map(([city, faction, governor]) => [city, { faction, governor }]));

function roster(cityId, rows) {
  const owner = ownershipByCity.get(cityId);
  if (!owner) throw new Error(`No owner for ${cityId}`);
  for (const row of rows.trim().split("\n").filter(Boolean)) {
    const [id, name, courtesy, rank, statText, biography] = row.trim().split("|");
    const [war, intelligence, leadership, politics, charm] = statText.split(",").map(Number);
    if (officers.some((officer) => officer.id === id)) throw new Error(`Duplicate officer ${id}`);
    officers.push({ id, name, courtesy, factionId: owner.faction, rank, war, intelligence, leadership, politics, charm, merit: rank === "君主" ? 5000 : rank === "大将" ? 3200 : rank === "军师" ? 2800 : 1200, portrait: "placeholder", loyalty: rank === "君主" ? 100 : 82 + (officers.length % 17), status: "active", locationCityId: cityId });
    biographies[id] = biography;
    residentIds.get(cityId).push(id);
  }
}

roster("xiaopei", `
liu-bei|刘备|玄德|君主|75,74,83,78,99|涿郡人，早年起兵，收揽关羽、张飞等追随者。徐州失守后暂屯小沛，仍以恢复事业为志。
guan-yu|关羽|云长|大将|97,75,94,63,92|河东解人，早年追随刘备，勇毅忠直，与张飞同为刘备军中支柱。
zhang-fei|张飞|益德|大将|98,40,87,30,49|涿郡人，少与关羽俱事刘备，勇猛善战。需以谋士与政务人才补其短处。
jian-yong|简雍|宪和|从事|31,72,43,76,83|刘备同乡旧交，善于谈论与交涉，性情简易洒脱，常为使者。
mi-zhu|糜竺|子仲|从事|27,73,40,86,88|东海富家出身，原为陶谦属吏。刘备困顿之际倾财相助，擅长财计与人脉经营。
sun-qian|孙乾|公祐|从事|35,78,46,82,84|北海人，学者郑玄曾予称荐。陶谦之后追随刘备，长于奉使与辞令。
mi-fang|糜芳|子方|校尉|61,50,57,58,58|糜竺之弟，随家族支持刘备。负责军需与地方守备，能力按游戏需要设定。
`);
roster("xuchang", `
cao-cao|曹操|孟德|君主|72,92,96,94,91|沛国谯人，善用兵与用人。迎汉献帝都许，并推行屯田以支撑连年征战。
xun-yu|荀彧|文若|军师|14,95,62,98,93|颍川人，曹操重要谋臣，主持后方与举荐人才，主张迎奉天子。
xun-you|荀攸|公达|军师|29,94,74,83,78|颍川人，熟悉朝政与军事筹划。归曹时间按建安初的游戏窗口处理。
guo-jia|郭嘉|奉孝|军师|22,96,74,70,80|颍川人，善于审察形势与人物。本剧本提前纳入建安初人才圈，归曹月份不作精确复原。
dian-wei|典韦||大将|96,36,66,26,65|陈留人，膂力过人，率亲兵护卫曹操，作战勇敢严整。
xu-chu|许褚|仲康|中郎将|96,33,67,24,60|谯人，曾聚族人自保，后率众归曹。以勇力与护卫见长。
zao-zhi|枣祗||从事|25,79,46,92,74|颍川人，参与曹操屯田制度的建立，为军粮与民生恢复提供规划。
ren-jun|任峻|伯达|从事|52,71,61,88,77|河南中牟人，主持军需与屯田事务，擅长后方组织。
man-chong|满宠|伯宁|校尉|64,81,78,84,62|山阳人，治法严明，兼通军政。此时在曹操麾下处理司法与地方事务。
`);
roster("puyang", `
xiahou-dun|夏侯惇|元让|大将|91,61,89,70,82|曹操宗族将领，早年即从起兵。既统兵也能抚民治田，是兖州的重要支柱。
cheng-yu|程昱|仲德|军师|48,92,73,84,55|东郡东阿人，在兖州危急时协助保全根本。谋断坚决，兼理地方军政。
yu-jin|于禁|文则|大将|77,74,86,57,66|泰山人，原从鲍信，后归曹操。治军严整，重视纪律与阵势。
yue-jin|乐进|文谦|中郎将|84,54,79,40,67|阳平卫国人，以胆烈从曹操，常先登破敌，善于率领精锐步兵。
mao-jie|毛玠|孝先|从事|29,75,51,88,76|陈留平丘人，倡言奉天子与修耕织，擅长选用清廉官吏。
`);
roster("chenliu", `
xiahou-yuan|夏侯渊|妙才|大将|91,63,87,58,73|曹操宗族将领，随军征讨多年，擅长快速进军与突击。
li-dian|李典|曼成|中郎将|76,78,77,72,74|山阳人，接领宗族部曲，重学问而识大体，能兼顾守备与后勤。
wei-zhong|卫臻|公振|从事|28,72,45,82,78|陈留襄邑人，出身地方士族。本剧本将其早期仕宦纳入陈留文官配置，具体驻地为游戏安排。
`);
roster("luoyang", `
dong-zhao|董昭|公仁|军师|30,86,58,87,76|济阴定陶人，辗转诸军间，劝曹操迎天子都许，长于政治判断。
zhong-yao|钟繇|元常|从事|21,84,54,94,82|颍川人，参与天子东归与朝廷重建。擅长政务、法制与书法。
han-hao|韩浩|元嗣|校尉|67,72,73,79,62|河内人，善于军务与守备，曾与枣祗等参与屯田建议。
yang-xiu|杨修|德祖|从事|29,82,35,75,67|弘农杨氏子弟，以才思与文辞知名。此时文职配置为游戏安排。
`);
roster("runan", `
li-tong|李通|文达|中郎将|83,61,79,58,70|江夏平春人，在汝南聚众自保后归曹，熟悉当地军事形势。
zhao-yan|赵俨|伯然|从事|29,81,59,88,77|颍川人，避乱后归曹。以理政与协调军队见长，具体早期驻地为游戏编排。
du-xi|杜袭|子绪|从事|31,79,53,85,80|颍川定陵人，处乱有识断。建安初归曹，此时担任地方文职。
`);
roster("qiao", `
cao-ren|曹仁|子孝|大将|86,65,88,55,77|曹操从弟，早年召集少年从军，善攻守，承担宗族军的重要职责。
cao-hong|曹洪|子廉|中郎将|81,49,77,46,65|曹操从弟，多次救援主帅，勇敢而熟悉征粮与军需。
cao-chun|曹纯|子和|中郎将|83,63,80,51,71|曹操族弟，领精锐骑兵，军中素有威信。骑兵编制以游戏单位表现。
liu-ye|刘晔|子扬|从事|44,91,62,75,71|淮南士人，识人料事，长于谋议。早期归属月份从宽处理，暂在曹氏地方幕府任职。
`);
roster("jibei", `
lv-qian|吕虔|子恪|校尉|75,66,76,70,69|任城人，率家兵助曹操，长于安抚地方与平定盗贼。驻济北为游戏安排。
bi-chen|毕谌||从事|28,62,42,73,57|东平人，曾任曹操兖州别驾，后在战乱中转附吕布。曹操平兖州后复用，具体驻地为游戏安排。
`);

roster("ye", `
yuan-shao|袁绍|本初|君主|69,78,87,83,88|汝南袁氏名门，起兵讨董后取得冀州，声望与兵力冠于河北。
tian-feng|田丰|元皓|军师|32,94,66,84,68|钜鹿人，博学多识，性刚直，善于长远谋划，是袁绍重要谋臣。
ju-shou|沮授||军师|37,93,83,89,77|广平人，兼通军略与政务，助袁绍经营河北，主张稳健发展。
shen-pei|审配|正南|军师|48,82,78,80,58|魏郡人，性情刚直，掌袁绍幕府事务，长于守备与组织。
xu-you|许攸|子远|军师|30,91,54,70,42|南阳人，早年与袁绍、曹操相识，谋略敏锐而性情贪纵。
feng-ji|逢纪|元图|从事|32,85,53,74,55|南阳人，为袁绍出谋划策，善于权谋与政略。
yan-liang|颜良||大将|94,44,83,32,61|袁绍麾下勇将，勇名著于河北，擅长率军正面突击。
wen-chou|文丑||大将|93,42,82,31,58|袁绍大将，以勇武见称，与颜良同为河北军的锐锋。
`);
roster("nanpi", `
yuan-xi|袁熙|显奕|中郎将|61,62,64,64,71|袁绍次子。此时尚未套用其后来领幽州的疆域，以袁氏宗族身份驻南皮。
chunyu-qiong|淳于琼|仲简|大将|76,48,72,40,55|曾任西园校尉，后从袁绍，领军经验丰富。
chen-lin|陈琳|孔璋|从事|17,78,32,83,77|广陵人，长于辞赋檄文，曾为何进主簿，后入袁绍幕府。
`);
roster("julu", `
zhang-he|张郃|儁乂|大将|90,77,91,57,73|河间人，早年从韩馥，后归袁绍，善用兵阵与地势。
xin-pi|辛毗|佐治|从事|28,82,51,87,76|颍川阳翟人，与兄辛评同在袁氏阵营，长于政务与进谏。
`);
roster("ganling", `
ju-yi|麹义||大将|82,73,88,47,55|袁绍部将，熟悉西州战法，以精兵破公孙瓒。其失和时间史载不精确，本剧本仍留袁军。
lv-kuang|吕旷||校尉|70,42,63,35,48|袁氏部将。早期具体军职未详，本剧本配置于甘陵守军。
lv-xiang|吕翔||校尉|68,43,61,36,49|袁氏部将，与吕旷同部。驻地与能力是游戏设定。
`);
roster("pingyuan", `
gao-lan|高览||大将|85,66,82,48,62|袁绍部将，能独领兵马。此时驻平原防守黄河渡口为游戏编排。
guo-tu|郭图|公则|军师|28,84,51,74,48|颍川人，袁绍谋臣，擅长权谋与朝廷事务。
`);
roster("beihai", `
yuan-tan|袁谭|显思|中郎将|70,63,72,58,66|袁绍长子，向青州进取，击败孔融后扩大袁氏在东部的影响。
guan-tong|管统||校尉|67,56,65,60,72|平原人，在袁氏青州军任职，以守节与地方声望著称。
`);
roster("donglai", `
wang-xiu|王修|叔治|从事|31,77,54,89,85|北海营陵人，曾辅孔融，后为袁谭所用。务实清直，善安百姓。
sun-shao-beihai|孙邵|长绪|从事|24,73,42,85,78|北海人，曾为孔融功曹，后南下江东。迁移时点不详，此剧本保留在青州地方士人圈。
`);
roster("linzi", `
xin-ping|辛评|仲治|从事|23,81,47,82,72|颍川人，先事韩馥后从袁绍，为袁氏政务与谋议人才。
cui-yan|崔琰|季珪|从事|39,74,48,84,81|清河东武城人，曾从郑玄受学，后来入袁绍幕府。归属月份与驻临淄为游戏概括。
`);
roster("jinyang", `
gao-gan|高干|元才|中郎将|73,68,76,69,67|袁绍外甥，后领并州。本剧本将其并州经营提前概括，用于表现袁氏北方影响。
liang-xi|梁习|子虞|从事|31,75,60,87,78|陈郡柘人，以地方治理著称。建安初仕宦与驻地简化为并州文吏，非断定当月属袁。
`);
roster("shangdang", `
guo-yuan|郭援||中郎将|76,59,73,47,56|袁氏将领，长于统兵。此时驻上党是为连结河北与并州而作的游戏配置。
gao-rou|高柔|文惠|从事|25,74,46,85,73|陈留人，高干从弟，后以司法政务知名。早期依宗族配置在并州。
`);

roster("xuzhou", `
lu-bu|吕布|奉先|君主|100,42,90,28,66|五原九原人，以骑射与勇力著称。夺取下邳后周旋诸侯之间，统属关系仍脆弱。
chen-gong|陈宫|公台|军师|53,93,78,82,69|东郡人，谋略出众，兖州之变后随吕布东入徐州，负责军政筹划。
gao-shun|高顺||大将|88,67,89,52,73|吕布将领，清白有威，统率精锐有法，擅长严整突击。
hou-cheng|侯成||校尉|74,48,66,40,53|吕布部将，参与骑兵与地方守备事务，具体能力为游戏设定。
wei-xu|魏续||校尉|72,46,64,38,52|吕布亲近部将，率兵作战，军职采用游戏统一等级。
song-xian|宋宪||校尉|73,43,62,35,49|吕布部将，随军辗转兖徐，负责前线兵马。
`);
roster("pengcheng", `
zhang-liao|张辽|文远|大将|92,80,93,58,77|雁门马邑人，历从丁原、董卓，后属吕布。兼具勇武、临阵判断与统军能力。
xu-si|许汜||从事|32,71,45,71,54|曾任兖州官吏，后随吕布，熟悉诸侯之间的交涉。
wang-kai|王楷||从事|36,64,47,63,57|曾参与兖州迎吕布之谋，随吕布入徐州。使者与政务能力作游戏化表现。
`);
roster("langya", `
zang-ba|臧霸|宣高|大将|86,68,84,64,77|泰山华人，聚众自保，与孙观等活动于青徐。剧本把其松散部曲纳入吕布阵营。
wu-dun|吴敦||校尉|72,48,66,42,55|泰山诸将之一，与臧霸等同起，具体驻地为游戏配置。
yin-li|尹礼||校尉|74,44,67,38,52|泰山诸将之一，参与青徐地方军事活动。隶属在本剧本中作统一处理。
`);
roster("taishan", `
sun-guan|孙观|仲台|中郎将|80,51,75,45,63|泰山人，与臧霸同起，勇敢善战，率领地方部曲。
chang-xi|昌豨||校尉|77,47,70,39,44|东海地方武装首领，反复于诸军之间。为地图操作归入泰山诸部。
`);
roster("guangling", `
chen-deng|陈登|元龙|军师|67,89,79,93,79|下邳淮浦人，精于治民与军略。此时名义附吕布，后来的广陵经营在游戏中先行概括。
chen-gui|陈珪|汉瑜|从事|19,85,37,85,74|下邳士族，审察时势，与子陈登共同影响徐州政局。
`);
roster("shouchun", `
yuan-shu|袁术|公路|君主|62,63,66,64,56|汝南名门，据寿春经营淮南。此时尚未称帝，部曲众多而赋役繁重。
ji-ling|纪灵||大将|83,51,78,44,58|袁术部将，曾领军攻刘备，受吕布辕门射戟调停。勇武统军能力为游戏设定。
yan-xiang|阎象||军师|25,83,45,84,73|袁术主簿，能直言利害，长于政治判断。
yang-hong|杨弘||从事|24,73,47,77,57|袁术长史，参与军政事务，在淮南幕府中颇有地位。
yuan-yin|袁胤||中郎将|53,59,55,58,57|袁术宗族，曾任丹阳太守，参与家族军政。
qiao-rui|桥蕤||中郎将|77,49,72,40,51|袁术将领，领淮南兵马，适合正面防守与出征。
zhang-xun|张勋||大将|78,56,78,47,60|袁术重要统军将领，统合淮南诸部。官阶以游戏统一等级表示。
han-yin|韩胤||从事|27,62,42,65,57|袁术使者，参与袁、吕间的联姻交涉，善于使节事务。
`);
roster("lujiang", `
liu-xun|刘勋|子台|中郎将|73,57,72,48,56|袁术所置庐江太守，拥兵于江淮之间。隶属袁术阵营是本剧本的名义关系处理。
zhou-yu|周瑜|公瑾|中郎将|73,95,96,82,93|庐江舒人，助孙策渡江后曾暂依袁术、求任居巢长。依此阶段配置庐江，尚未固定回到孙策麾下。
zheng-bao|郑宝||校尉|69,41,63,35,42|淮南地方武装首领，欲拥众渡江。此时按名义依附袁术的地方部曲配置，非确定正式隶属。
`);

roster("wu", `
sun-ce|孙策|伯符|君主|94,75,93,70,92|孙坚长子，借兵渡江，连破江东诸敌。锐意进取，善于吸纳能人。
zhang-zhao|张昭|子布|军师|24,86,58,95,85|彭城人，避乱江东，助孙策处理内政文书，刚直有名望。
zhang-hong|张纮|子纲|军师|22,87,52,91,84|广陵人，博学善文，为孙策筹划内外政务。
zhu-zhi|朱治|君理|中郎将|72,68,77,75,76|丹阳人，孙坚旧部，辅孙策经营吴郡，兼能抚民与统军。
lv-fan|吕范|子衡|校尉|66,76,74,78,73|汝南人，随孙策征战，善于治军与组织，勇于承担纪律责任。
qin-song|秦松|文表|从事|27,76,41,80,70|广陵人，孙策谋主之一，长于文书与谋议。
`);
roster("jianye", `
cheng-pu|程普|德谋|大将|85,75,89,68,80|右北平人，孙坚旧将，年长而有威望，兼有勇武与识断。
huang-gai|黄盖|公覆|中郎将|86,64,80,60,70|零陵人，随孙坚起兵，经历多次征战，治军果断。
jiang-qin|蒋钦|公奕|中郎将|83,57,78,43,66|九江寿春人，孙策渡江时归附，以勇猛与水战经验见长。
zhou-tai|周泰|幼平|中郎将|90,48,77,35,68|九江下蔡人，与蒋钦同归孙策，作战奋勇，善护主帅。
taishi-ci|太史慈|子义|大将|95,72,86,52,79|东莱黄县人，曾助孔融与刘繇，后归孙策。归附过程的月份未作强断，以江东新定阶段配置。
dong-xi|董袭|元代|校尉|85,48,72,37,65|会稽余姚人，随孙策征战，勇力过人，擅长突击。
chen-duan|陈端||从事|22,72,40,76,69|孙策早期谋主之一，史料事迹较少，具体职级与驻地为游戏安排。
`);
roster("kuaiji", `
sun-jing|孙静|幼台|中郎将|70,69,72,64,73|孙坚之弟，助孙策征会稽，熟悉江东形势与乡里人脉。
yu-fan|虞翻|仲翔|从事|44,87,53,86,67|会稽余姚人，原为王朗功曹，孙策取会稽后继续任用，博学而敢言。
sun-ben|孙贲|伯阳|中郎将|75,59,72,58,68|孙坚侄子，历领孙氏部曲，与孙策共同经营江东。此时郡守任职不按后来扩张套用。
sun-fu|孙辅|国仪|校尉|66,53,63,50,57|孙贲之弟，随孙策渡江。此时仍在江东军中，未提前安排到庐陵。
he-qi|贺齐|公苗|校尉|78,72,79,71,69|会稽山阴人，从郡县吏起，熟悉山地与地方治理，军事才能渐露。
`);
roster("jianan", `
han-dang|韩当|义公|大将|85,58,81,48,71|辽西令支人，善弓马，历从孙坚、孙策。本剧本配置于会稽南部守军。
ling-cao|凌操||校尉|81,45,69,36,62|吴郡余杭人，从孙策征讨，以勇敢先登著称。驻地按游戏需要安排。
`);
roster("yuzhang", `
liu-yao|刘繇|正礼|君主|57,68,65,78,76|东莱人，曾为扬州刺史，与袁术相拒。败于孙策后退入豫章，收集旧部。
zhang-ying|张英||中郎将|75,47,69,42,52|刘繇部将，曾在长江沿线防御孙氏军。战后配置于豫章，具体去向为游戏推演。
fan-neng|樊能||校尉|69,44,62,37,48|刘繇部将，参与江东防御。战败后去向史载不详，本剧本以残部收拢处理。
`);
roster("luling", `
hua-xin|华歆|子鱼|军师|24,83,50,91,82|平原高唐人，任豫章太守，治事简静，士民爱戴。剧本与刘繇合为当地联合阵营。
`);

roster("xiangyang", `
liu-biao|刘表|景升|君主|42,75,67,87,85|山阳高平人，受命入荆州后平定宗贼、招纳士人，以地方豪族为依托。
kuai-liang|蒯良|子柔|军师|28,86,48,85,76|南郡中庐人，助刘表稳定荆州，长于谋议与政治协调。
kuai-yue|蒯越|异度|军师|34,88,62,88,77|蒯良族人，才兼文武，熟悉荆州地方势力，为刘表奠定根基出力甚多。
liu-qi|刘琦||从事|44,65,50,63,76|刘表长子，此时在荆州幕府历练。尚未预设后来荆州继承冲突的结局。
han-song|韩嵩|德高|从事|20,78,38,81,77|义阳人，学识与节操为士人所重，在刘表幕府处理政务。
yi-ji|伊籍|机伯|从事|28,79,40,83,83|山阳人，早年依刘表，善于交涉文书与法令。
`);
roster("xinye", `
wen-pin|文聘|仲业|大将|83,68,87,61,73|南阳宛人，刘表大将，承担荆州北面防御。为人忠厚而善守。
liu-pan|刘磐||中郎将|77,53,71,43,59|刘表从子，领兵活动于荆州，具体初期驻地按北部防线作游戏配置。
`);
roster("jiangling", `
cai-mao|蔡瑁|德珪|大将|70,73,76,74,61|襄阳大族，参与刘表经营荆州，拥有地方人脉与兵众。
zhang-yun|张允||中郎将|68,58,68,49,53|刘表亲近的统军人物，具体早期任职与驻地为游戏概括。
wang-can|王粲|仲宣|从事|17,84,34,78,70|山阳人，避乱荆州的文士，博闻强记，擅长文辞与制度议论。
liu-xian|刘先|始宗|从事|28,75,44,81,69|零陵人，博学识典，任刘表别驾，长于政务文书。
`);
roster("jiangxia", `
huang-zu|黄祖||大将|75,56,78,44,54|刘表部将，据江夏扼长江要道，与孙氏结有深仇，擅守水陆关隘。
su-fei|苏飞||校尉|71,59,68,54,66|江夏军将领，识人而有义气。具体驻地沿用江夏军所属。
huang-she|黄射||校尉|65,52,61,46,51|黄祖之子，参与江夏军政，兼有地方人脉。
`);
roster("shangyong", `
shen-dan|申耽|义举|校尉|62,57,60,59,52|上庸豪族，后来在汉中、荆州之间自保。早期配置为地方守备，不断言此时正式隶属刘表。
shen-yi|申仪||校尉|59,53,57,56,48|申耽之弟，地方宗族武装成员，早期身份与能力为游戏配置。
`);
roster("wuling", `
jin-xuan|金旋|元机|校尉|65,49,58,57,52|京兆人，后任武陵太守。为填充荆南经营层，提前按后来活动地区配置，并非196年实任复原。
`);
roster("changsha", `
han-xuan|韩玄||从事|36,46,42,58,44|后见于长沙太守记载，建安元年职务不详。本剧本提前配置于长沙，明确属于游戏补全。
huang-zhong|黄忠|汉升|大将|94,61,86,49,73|南阳人，曾在刘表麾下任中郎将，与刘磐共守长沙一带。年资与能力作游戏化设定。
`);
roster("guiyang", `
zhao-fan|赵范||从事|40,52,47,61,51|后见于桂阳太守记载，196年职务不详。驻桂阳是游戏补全，不是确证履历。
`);
roster("lingling", `
liu-du|刘度||从事|39,49,45,60,53|后见于零陵太守记载，196年职务不详。按后来活动地区提前配置，为剧本经营服务。
liu-ba|刘巴|子初|从事|22,86,35,90,65|零陵烝阳人，少有名声，长于财计。此时地方文士配置为游戏近似。
`);

roster("chengdu", `
liu-zhang|刘璋|季玉|君主|34,50,46,72,77|刘焉之子，继领益州。性宽柔，境内本地豪族与东州集团并存。
huang-quan|黄权|公衡|军师|53,88,80,86,72|巴西阆中人，起于郡吏，善于审察军事形势，后为益州重要谋臣。
wang-lei|王累||从事|21,74,39,78,72|广汉人，益州从事，以忠直著称。早期任职按刘璋幕府编排。
zheng-du|郑度||军师|24,83,45,76,58|广汉人，刘璋谋士，擅长防御策略与物资谋划。
qin-mi|秦宓|子敕|从事|20,79,31,76,80|广汉绵竹人，博学能辩。此时以地方士人身份参与州府事务。
wu-yi|吴懿|子远|大将|81,69,84,66,74|陈留人，随刘焉入蜀，参与益州军事。宗族与东州人士关系深厚。
zhang-song|张松|永年|从事|26,87,39,84,56|蜀郡成都人，博闻强记，后来任益州别驾。早期幕职为游戏补全。
`);
roster("zitong", `
zhang-ren|张任||大将|87,72,88,52,71|蜀郡人，出身寒门而有胆勇，后在益州守战中成名。此时军职为游戏安排。
leng-bao|冷苞||校尉|77,52,72,42,54|益州将领，史料主要见于后来战事。按刘璋部将配置早期军职。
deng-xian|邓贤||校尉|74,53,70,44,53|刘璋部将，具体早期经历未详，军职、驻地为游戏配置。
`);
roster("jiangzhou", `
yan-yan|严颜||大将|88,67,83,55,77|巴郡临江人，守备经验丰富，以勇壮与气节著称。驻江州表示巴郡防务。
zhang-yi|张裔|君嗣|从事|49,74,58,86,76|蜀郡成都人，通晓经书，治事有才。早期郡县职务从宽配置。
wang-shang|王商|文表|从事|24,73,35,85,76|广汉人，博学有识，曾任刘璋治中与蜀郡太守，善地方治理。
`);
roster("yongan", `
liu-kui|刘璝||中郎将|76,56,73,46,57|刘璋将领，后来参与益州防御。以永安代表巴东门户，驻地为游戏配置。
wu-ban|吴班|元雄|校尉|78,49,71,45,63|吴懿族弟，豪侠有名，在益州军中任职。早期具体驻地未详。
`);
roster("yuexi", `
jiao-huang|焦璜||校尉|67,46,61,39,49|刘璋部将，曾参与对汉中用兵。配置在边郡表示益州分散军力。
gao-pei|高沛||校尉|71,48,65,41,51|刘璋将领，后来守涪关。此时军职与驻地为游戏安排。
`);
roster("zangke", `
dong-he|董和|幼宰|从事|33,77,47,91,82|南郡人，率宗族入蜀，治政清俭，善于安抚地方族群。
liu-huang|刘璜||校尉|66,47,60,42,48|益州军将领，史料记载简略。驻南中是为边郡经营而作的游戏配置。
`);
roster("jianning", `
yong-kai|雍闿||校尉|69,54,65,57,53|益州郡豪族，地方势力深厚。此时按名义服属刘璋的地方首领处理，不预设后来反叛。
zheng-ang|正昂||从事|26,58,39,72,61|后来担任益州郡太守，早期履历未详。提前配置于本地，为南中治理作游戏补全。
`);
roster("yongchang", `
lv-kai|吕凯|季平|从事|43,71,58,79,76|永昌不韦人，熟悉乡土形势，后来保境有功。此时职级与能力按早期地方人才配置。
wang-kang|王伉||校尉|63,67,64,71,69|永昌地方官吏，后来与吕凯协力守郡。早期配置是游戏补全。
`);
roster("hanzhong", `
zhang-lu|张鲁|公祺|君主|44,73,65,83,88|沛国丰人，据汉中推行五斗米道组织，以祭酒治理民众，兼行政与宗教威望。
yan-pu|阎圃||军师|30,86,50,82,74|巴西安汉人，为张鲁谋主，能判断汉中所处形势与进退。
zhang-wei|张卫||大将|78,56,77,44,59|张鲁之弟，参与汉中军务，负责关隘守备。
yang-song|杨松||从事|25,68,39,65,37|张鲁近臣，史料事迹不多。能力与政务用途按游戏设定，不套用全部演义情节。
yang-ren|杨任||中郎将|79,58,75,43,61|张鲁部将，承担汉中守备，战阵能力按游戏设定。
`);
roster("wudu", `
yang-ang|杨昂||中郎将|76,51,72,39,53|张鲁部将，以武都节点代表汉中西北方向军力影响，非精确实控复原。
yang-qianwan|杨千万||校尉|70,48,64,44,59|武都氐人首领，史载活动年代较宽。此时与汉中阵营合并，具体服属为游戏处理。
`);
roster("wan", `
zhang-xiu|张绣||君主|85,64,82,51,66|武威祖厉人，张济从子，接领部众后屯宛，依托刘表求生存。
jia-xu|贾诩|文和|军师|37,98,75,86,58|武威姑臧人，善审局势与人心，辗转李傕、段煨后为张绣谋划。
hu-cheer|胡车儿||校尉|82,29,54,24,39|张绣军中壮士，以勇力闻名，适合作为突击先锋。
`);

roster("tianshui", `
ma-teng|马腾|寿成|君主|82,62,82,61,77|扶风茂陵人，凉州军首领之一。联结西州诸部，家族善于骑战。
ma-dai|马岱||中郎将|84,61,77,48,64|马腾从子，随马氏转战。早年职级与驻地按家族军配置。
yang-fu|杨阜|义山|从事|47,81,68,82,75|天水冀人，熟悉陇右军政，后来以守土见称。此时地方文职与归属为游戏配置。
`);
roster("anding", `
ma-chao|马超|孟起|大将|97,55,88,39,78|马腾长子，年轻而勇武，在西州军中崭露头角。此时能力保留成长空间。
ma-xiu|马休||校尉|66,42,58,40,52|马腾之子，作为家族部曲成员配置，早期军职史载不详。
`);
roster("longxi", `
pang-de|庞德|令明|大将|94,70,86,44,70|南安狟道人，早年在州郡任职，后从马腾，以勇猛与忠毅著称。
ma-tie|马铁||校尉|63,41,56,39,50|马腾之子，此时按宗族守备配置，非精确官职复原。
`);
roster("jincheng", `
han-sui|韩遂|文约|君主|73,78,81,65,72|金城人，长期经营西州军力，善于联结诸将与地方势力。
liang-xing|梁兴||中郎将|77,49,70,37,50|关西将领之一，与韩遂等往来。早期编入韩遂阵营，具体隶属为游戏概括。
ma-wan|马玩||校尉|71,44,65,34,47|关西将领，史料主要见于后来的联军。按地方武装提前配置。
`);
roster("wuwei", `
cheng-gongying|成公英||军师|61,82,75,72,68|金城人，早年追随韩遂，忠实可靠，兼有谋略与统军才能。
hou-xuan|侯选||校尉|72,45,66,36,49|关西将领，后来参与关中联军。早期军职与驻地作游戏补全。
`);
roster("xiping", `
yan-xing|阎行|彦明|大将|88,64,81,42,62|金城人，韩遂部将，勇武而有威名，兼能处理军政关系。
yang-qiu|杨秋||校尉|75,49,68,42,51|安定地方将领，后见于关中联军。本剧本将其早期势力合入韩遂阵营。
`);
roster("changan", `
li-jue|李傕|稚然|君主|75,47,71,26,32|董卓旧部，曾与郭汜控制长安与朝廷。天子东归后仍据关中一隅。
guo-si|郭汜||大将|78,37,68,22,28|董卓旧将，与李傕互相攻伐。本剧本合并关中余部供操作，绝非当时稳定盟友。
li-li|李利||校尉|70,39,61,28,35|李傕从子，曾参与关中作战，勇武而缺乏独立经营经验。
wu-xi|伍习||校尉|65,47,58,33,37|郭汜部将，后来袭杀郭汜。此时仍按关中军中将领配置。
`);
roster("hongnong", `
duan-wei|段煨|忠明|君主|67,72,72,76,70|武威人，董卓旧将中较重抚民的一支，在弘农劝农护民，供给东归朝廷。
huangfu-li|皇甫郦||从事|42,73,49,68,70|皇甫嵩从子，曾奉命调停李傕、郭汜。具体驻地为关中士人配置。
`);
roster("henei", `
zhang-yang|张杨|稚叔|君主|73,58,69,65,73|云中人，据河内，曾为天子提供粮食并修缮宫室，与吕布有旧交。
yang-chou|杨丑||校尉|70,44,62,35,38|张杨部将，后来卷入河内内部变乱。此时配置为当地守备。
sui-gu|眭固|白兔|校尉|73,42,65,33,45|原黑山军将领，后属张杨，拥有自己的部曲。
`);
roster("hedong", `
wang-yi|王邑|文都|君主|48,67,56,79,77|北地泥阳人，任河东太守，曾供给东归的汉献帝，以郡府独立求存。
wei-gu|卫固||从事|40,63,49,68,51|河东地方人士，拥有乡里势力。具体早期职务按地方幕府配置。
fan-xian|范先||校尉|65,44,59,39,44|河东地方武装人物，后与卫固等共同活动，提前配置为郡府守备。
`);
roster("changshan", `
zhang-yan|张燕|飞燕|君主|82,65,81,44,74|常山真定人，黑山军首领，行动轻捷，善于山地战与联合地方部众。
bai-rao|白绕||校尉|72,39,64,29,44|黑山军首领之一，早年兵败后行踪不详。本剧本以残部重聚处理，非确证仍在此地。
`);
roster("beiping", `
gongsun-zan|公孙瓒|伯珪|君主|85,65,85,53,71|辽西令支人，以边地骑兵立威，长期与袁绍争夺河北，近年转趋固守。
guan-jing|关靖|士起|从事|28,69,43,64,58|太原人，公孙瓒长史，参与军事与地方决策。
`);
roster("zhongshan", `
tian-kai|田楷||中郎将|69,61,70,57,62|公孙瓒部将，曾在青州与袁绍军相争。退出青州后并入本阵营后方。
gongsun-xu|公孙续||校尉|68,48,62,39,54|公孙瓒之子，参与联络黑山诸部与家族军事。
`);
roster("ji", `
xianyu-fu|鲜于辅||君主|73,67,76,65,78|渔阳人，刘虞旧部，聚集州兵与地方势力对抗公孙瓒。
yan-rou|阎柔||军师|61,78,72,68,82|广阳人，熟悉北边诸部，能联结乌桓鲜卑，在幽州军政间颇有影响。
`);
roster("daijun", `
xianyu-yin|鲜于银||中郎将|72,56,69,47,64|与鲜于辅同为刘虞旧部，联结幽州兵众，与公孙瓒抗衡。
qi-zhou|齐周||校尉|61,61,59,61,64|刘虞故吏，参与旧部反攻公孙瓒。此时驻代郡为游戏配置。
`);
roster("liaoxi", `
tadun|蹋顿||大将|82,63,80,39,75|辽西乌桓首领，联结诸部，与袁绍关系密切。此时并入抗瓒联合阵营。
supu-yan|苏仆延||中郎将|73,49,68,35,62|辽东属国乌桓首领，拥有边地部众。与蹋顿合并阵营属游戏简化。
`);
roster("xiangping", `
gongsun-du|公孙度|升济|君主|67,72,73,75,65|辽东襄平人，任辽东太守后扩张势力，经营辽海并招纳流亡人口。
gongsun-kang|公孙康||中郎将|72,65,71,61,59|公孙度之子，参与辽东军政，能力按继承人早期阶段设定。
liang-mao|凉茂|伯方|从事|24,77,42,83,75|山阳昌邑人，曾为乐浪太守而滞留辽东。具体到辽时间不详，此时作为流寓文士配置。
`);
roster("xuantu", `
gongsun-gong|公孙恭||从事|32,51,43,61,52|公孙度之子，辽东宗族成员，负责边郡文政为游戏配置。
liu-yi-liaodong|柳毅||校尉|71,48,65,41,46|公孙氏军将，早期经历不详，按辽东地方守备配置。
`);
roster("yunzhong", `
huchuquan|呼厨泉||君主|75,56,73,39,70|南匈奴单于，於夫罗之弟。南匈奴实际活动于并州多地，本剧本以北边节点统一表示。
liu-bao|刘豹||中郎将|71,55,68,46,67|南匈奴贵族，於夫罗之子，后来领部众。此时以年轻宗族首领配置。
`);
roster("yanmen", `
qu-bei|去卑||大将|73,61,73,45,68|南匈奴贵族，与呼厨泉等有关联。具体早期职位不详，作为部众统领配置。
`);
roster("zhangye", `
zhang-meng|张猛|叔威|校尉|63,61,63,62,52|张奂之子，早年在河西活动，曾建议河西另置州。后来任武威太守；此时职级与驻张掖为游戏配置。
`);
roster("dunhuang", `
yin-feng|尹奉|次曾|君主|63,65,62,68,62|天水人，曾任敦煌太守。任期细节未完全确证，以河西郡府操作代表身份配置；君主只是游戏职级。
zhang-gong|张恭|节义|从事|38,71,51,78,72|敦煌人，后来在河西维护交通。此时以地方年轻吏员配置，非提前赋予后来的官职。
`);
roster("jiuquan", `
huang-yan|黄衍||从事|36,65,47,71,59|凉州官吏，曾参与王国等人的事务，熟悉河西局势。此时驻酒泉为游戏安排。
pang-yu|庞淯|子异|校尉|64,68,61,64,70|酒泉表氏人，以节义著称，早年任郡吏。具体军职按本剧本守备需要安排。
`);
roster("jiaozhi", `
shi-xie|士燮|威彦|君主|35,78,58,91,88|苍梧广信人，任交趾太守，重经学而招纳流寓，地方威望深厚。
shi-yi|士壹||从事|39,67,48,75,71|士燮之弟，早年任郡吏与地方官。此时留在士氏交趾阵营，未预设后来合浦太守之职。
shi-huang|士䵋||从事|37,61,45,70,66|士燮之弟，后来领九真。此时作为士氏宗族幕僚配置，不提前占领后来辖地。
shi-wu|士武||校尉|54,55,52,66,62|士燮之弟，后来领郁林。此时在士氏阵营协助军政。
`);
roster("cangwu", `
zhu-fu|朱符||君主|43,54,50,58,39|交州刺史，史书记其用吏失当、地方离心。剧本仍置其在196年，并以郡府联合表示名义控制。
cheng-bing|程秉|德枢|从事|22,79,35,86,78|汝南南顿人，避乱交州的经学士人。具体早期投属不详，暂作当地文教人才配置。
`);

const freeRows = [
  ["zhao-yun", "赵云", "子龙", "大将", [94,76,88,65,83], "beiping", "常山真定人，曾从公孙瓒并结识刘备。暂离原部后的行踪未详，本剧本以北平在野人才表示。"],
  ["lu-su", "鲁肃", "子敬", "从事", [55,89,80,91,90], "lujiang", "临淮东城人，家资富厚而有远略。此时尚未成为孙权谋臣，可在淮南寻访。"],
  ["xu-shu", "徐庶", "元直", "从事", [60,91,74,80,80], "xuchang", "颍川人，少时任侠，后折节向学。以早期游学阶段登场，驻地作游戏近似。"],
  ["gan-ning", "甘宁", "兴霸", "中郎将", [93,69,83,30,59], "jiangxia", "巴郡临江人，早年率部活动，后转入荆州。迁移年月未详，暂以江夏在野配置。"],
  ["fa-zheng", "法正", "孝直", "从事", [32,87,65,72,52], "changan", "扶风郿人，年轻时逢乱，后来入蜀。此时以未仕关中人才登场，能力保留成长空间。"],
  ["meng-da", "孟达", "子度", "校尉", [72,69,71,62,56], "changan", "扶风人，后与法正等入蜀。此时以地方武人配置，不提前绑定后来的阵营。"],
  ["bu-zhi", "步骘", "子山", "从事", [40,79,64,86,76], "wu", "临淮淮阴人，避乱江东，曾劳作求生，以学识与品行渐为人知。"],
  ["wei-yan", "魏延", "文长", "校尉", [88,65,79,39,52], "xiangyang", "义阳人，早期经历史载不详。作为荆州可发现的年轻武人是游戏安排。"],
  ["wang-lang", "王朗", "景兴", "从事", [26,82,43,88,78], "kuaiji", "东海郯人，原会稽太守，败于孙策后退避。此时作为暂未归属的文官登场。"],
  ["kong-rong", "孔融", "文举", "从事", [20,76,37,79,90], "beihai", "鲁国人，北海失守后离开青州。本剧本保留在北海人才池便于寻访，位置为游戏抽象。"],
  ["zheng-xuan", "郑玄", "康成", "从事", [10,88,25,86,96], "beihai", "北海高密人，经学名家，以授徒与著述闻名。可招揽机制代表邀请讲学与辅政，并非强行改写其仕途。"],
  ["hua-tuo", "华佗", "元化", "从事", [25,88,27,62,88], "qiao", "沛国谯人，医术著名，周游治病。寻访登用代表延请医者，尚未另设医术系统。"]
];
for (const [id, name, courtesy, rank, stats, locationCityId, biography] of freeRows) {
  const [war, intelligence, leadership, politics, charm] = stats;
  officers.push({ id, name, courtesy, factionId: "neutral", rank, war, intelligence, leadership, politics, charm, merit: 0, portrait: "placeholder", loyalty: 75, status: "free", locationCityId, discovered: false });
  biographies[id] = biography;
}

const regionBase = {
  河西: [41,44,65], 西北: [44,35,59], 关中: [32,32,40], 北地: [35,29,54],
  河东: [51,40,60], 河北: [64,51,64], 辽东: [44,39,62], 青徐: [59,52,58],
  中原: [57,54,57], 江淮: [62,56,54], 江东: [60,55,65], 荆襄: [68,59,72],
  荆南: [59,44,64], 巴蜀: [72,62,73], 南中: [44,31,58], 岭南: [51,44,64]
};
// City garrisons are scenario resources, independent of stationed officers and
// their expedition command caps. Keep the established opening troop balance.
const garrisonTroops = Object.fromEntries(`
dunhuang|5900
jiuquan|3700
zhangye|3700
wuwei|4600
jincheng|9300
xiping|5700
longxi|5700
tianshui|8700
anding|5700
changan|8800
yunzhong|7200
yanmen|5100
daijun|5000
jinyang|4400
shangdang|4400
hedong|8000
hongnong|5900
ji|6800
beiping|5900
liaoxi|6400
xiangping|8700
xuantu|3700
zhongshan|5000
changshan|6400
julu|5100
ganling|6500
ye|17000
nanpi|6500
pingyuan|6100
beihai|5000
donglai|3100
linzi|3100
jibei|5300
taishan|5000
langya|6500
henei|8600
luoyang|3800
chenliu|6500
puyang|6500
xuchang|15500
runan|6000
qiao|6500
xiaopei|10500
pengcheng|6500
xuzhou|11600
shouchun|13900
guangling|4100
lujiang|6500
jianye|6500
wu|11100
kuaiji|6500
yuzhang|9300
jianan|5700
luling|4100
wan|9000
xinye|6400
xiangyang|10500
shangyong|4300
jiangxia|6500
jiangling|6500
wuling|3700
changsha|5100
guiyang|3700
lingling|3100
wudu|5000
hanzhong|11500
zitong|6500
chengdu|11700
jiangzhou|6500
yongan|5000
yuexi|4300
zangke|3700
jianning|3700
yongchang|3700
yunnan|3700
nanhai|3700
cangwu|5900
yulin|3700
hepu|3700
jiaozhi|9600
chaisang|3700
`.trim().split("\n").map((row) => {
  const [cityId, troops] = row.split("|");
  return [cityId, Number(troops)];
}));
const cityOverrides = {
  xiaopei: { agriculture: 54, commerce: 42, popularSupport: 73, gold: 1850, food: 12600, troops: 10500, training: 68, morale: 77 },
  xuchang: { agriculture: 73, commerce: 68, popularSupport: 70, gold: 3200, food: 17500, troops: 15500, training: 78, morale: 83 },
  xuzhou: { agriculture: 62, commerce: 60, popularSupport: 53, gold: 2200, food: 13300, troops: 11600, training: 77, morale: 75 },
  ye: { agriculture: 78, commerce: 73, popularSupport: 74, gold: 3600, food: 19000, troops: 17000, training: 78, morale: 82 },
  shouchun: { agriculture: 72, commerce: 69, popularSupport: 45, gold: 3100, food: 16300, troops: 13900, training: 67, morale: 72 },
  wu: { agriculture: 68, commerce: 71, popularSupport: 68, gold: 2700, food: 14500, troops: 11100, training: 76, morale: 84 },
  chengdu: { agriculture: 85, commerce: 74, popularSupport: 76, gold: 3400, food: 19000, troops: 11700, training: 63, morale: 73 },
  xiangyang: { agriculture: 82, commerce: 75, popularSupport: 78, gold: 3300, food: 18200, troops: 10500, training: 64, morale: 73 },
  changan: { agriculture: 25, commerce: 28, popularSupport: 29, gold: 1100, food: 8200, troops: 8800, training: 68, morale: 52 },
  luoyang: { agriculture: 22, commerce: 25, popularSupport: 41, gold: 750, food: 5900, troops: 3800, training: 57, morale: 63 }
};
const capitals = new Set(factions.map((faction) => faction.capitalId));
const cities = atlas.cities.map((city, index) => {
  const owner = ownershipByCity.get(city.id) ?? { faction: "neutral", governor: null };
  const officerIds = residentIds.get(city.id);
  if (owner.governor && !officerIds.includes(owner.governor)) throw new Error(`Invalid governor for ${city.id}`);
  const [agriculture, commerce, popularSupport] = regionBase[city.region];
  const delta = index % 7 - 3;
  const troops = garrisonTroops[city.id] ?? 0;
  if (!Number.isInteger(troops) || troops < 0) throw new Error(`Invalid garrison for ${city.id}`);
  return {
    id: city.id, name: city.name, province: city.province, factionId: owner.faction,
    agriculture: agriculture + delta, commerce: commerce - delta, popularSupport: popularSupport + delta,
    gold: 850 + (agriculture + commerce) * 7 + (capitals.has(city.id) ? 500 : 0),
    food: 4500 + agriculture * 75 + Math.floor(troops * 0.25), troops,
    training: 55 + index % 15, morale: 60 + index % 13,
    governorId: owner.governor || null, officerIds,
    ...cityOverrides[city.id]
  };
});

const historicalNotes = [
  "以建安元年十一月（196年末）为开局锚点：迎帝都许、吕布据下邳、刘备屯小沛、孙策取吴会。各传记叙事先后不完全一致，按同年主要事件构造可玩的近似快照。",
  "81座地图节点覆盖整个游戏区域，边郡和松散联盟归并为25个操作势力；色彩代表游戏管辖，不宣称精确实控边界。保留建业、建宁等玩家熟悉的后世城名。",
  "青州归袁绍，孔融列为在野；会稽归孙策，王朗列为在野；周瑜仍配置于袁术所辖庐江。孙权、诸葛亮等年少人物尚未列为可统军的强将。",
  "无确切任职年代的地方人物按活动地区安排；荆南四郡、南中、河西、并州等尤其采用明确标注的提前配置。职级、五维、人口物资与兵数均为原创游戏平衡值。",
  "人物名单不添加虚构地方官或自动补足人数。城市可以没有驻留武将、太守职位可以空缺，也允许无势力占领的城市；城池归属与驻军独立配置。头像暂用公共占位图。"
];
// Compatibility metadata only: these deleted prototype roles must not survive
// in older saves, even if an old record has lost its fictional flag.
const removedPlaceholderOfficerIds = [
  "zhang-miao-you", "bao-xin-you", "sun-shao-liu", "ze-sheng", "zhang-hong-yuzhang",
  "gong-zhi", "guiyang-captain", "yong-shou", "yunnan-captain", "yanmen-clerk",
  "zhangye-clerk", "nanhai-clerk", "nanhai-captain", "yulin-clerk", "yulin-captain",
  "hepu-clerk", "hepu-captain"
];
const scenario = {
  id: "jianan-196", version: 3, title: "建安肇始", subtitle: "建安元年十一月 · 群雄逐鹿", year: 196, month: 11,
  description: "天子定都许县，河北袁氏雄踞，徐州易主，孙策席卷江东。二十五方势力共争天下。",
  introduction: "建安元年，天子辗转东归，曹操迎驾都许，始兴屯田。北方袁绍兵强地广，公孙瓒尚守幽冀；吕布夺取下邳，刘备暂栖小沛；孙策横渡长江，江东新定。荆益诸牧据险自守，西州与边郡各有豪杰。请择一方势力，任贤养民、练兵积粮，从这一月开始书写自己的天下。",
  playerFactionId: "liu-bei", historicalNotes, factions, cities, officers, removedPlaceholderOfficerIds,
  scenarioNotesPath: "./data/scenario-notes.json"
};
// Fixed terms stand for the opening diplomatic balance, not dated historical
// treaties. They give small states room to develop before relations change.
scenario.relations = Object.fromEntries([
  ["cao-cao", "yuan-shao", 70, 12],
  ["liu-bei", "lu-bu", 50, 3],
  ["liu-bei", "cao-cao", 58, 0],
  ["liu-biao", "zhang-xiu", 85, 18],
  ["yuan-shao", "xianyu-fu", 78, 12],
  ["gongsun-zan", "zhang-yan", 72, 12],
  ["ma-teng", "han-sui", 60, 6],
  ["liu-yao", "liu-biao", 64, 6],
  ["shi-xie", "zhu-fu", 52, 6],
  ["sun-ce", "yuan-shu", 35, 3],
  ["yuan-shao", "gongsun-zan", 5, 0],
  ["li-jue", "duan-wei", 12, 0]
].map(([a, b, friendliness, months]) => [[a, b].sort().join("|"), { friendliness, allianceUntil: months ? 196 * 12 + 11 + months : 0 }]));

const notes = {
  scenarioId: scenario.id, date: "196-11", title: "建安元年剧本编制说明", checkedOn: "2026-10-21",
  sources: [
    { title: "《三国志》卷一·武帝纪", url: "https://zh.wikisource.org/zh-hant/三國志/卷01", supports: "建安元年迎天子都许、十月击杨奉、屯田、张济死而张绣领众。" },
    { title: "《三国志》卷六·董卓袁绍刘表传", url: "https://zh.wikisource.org/zh-hant/三國志/卷06", supports: "李傕郭汜余部、马腾韩遂西归、袁绍与刘表的势力结构。" },
    { title: "《三国志》卷七·吕布传", url: "https://ctext.org/text.pl?if=gb&node=602263", supports: "吕布夺下邳，刘备暂屯小沛，陈氏父子与吕布的关系。" },
    { title: "《三国志》卷八·公孙瓒等传", url: "https://zh.wikisource.org/zh-hant/三國志/卷08", supports: "公孙瓒、刘虞旧部、张杨、公孙度、张燕、张绣与张鲁等边地势力。" },
    { title: "《三国志》卷三十一·刘二牧传", url: "https://zh.wikisource.org/zh-hant/三國志/卷31", supports: "刘焉死后刘璋继领益州，州内派系与对汉中的关系。" },
    { title: "《三国志》卷三十二·先主传", url: "https://zh.wikisource.org/zh-hant/三國志/卷32", supports: "196年刘备与袁术作战、下邳失守与小沛阶段。" },
    { title: "《三国志》卷四十六·孙破虏讨逆传", url: "https://zh.wikisource.org/zh-hant/三國志/卷46", supports: "孙策渡江、吴会进取与早期谋主；同篇后段的豫章庐陵任命未全部倒推至196年。" },
    { title: "《三国志》卷四十九·刘繇太史慈士燮传", url: "https://zh.wikisource.org/zh-hant/三國志/卷49", supports: "刘繇退豫章、华歆与士氏集团；士氏后来分领诸郡不提前完整套用。" },
    { title: "《三国志》卷五十四·周瑜鲁肃吕蒙传", url: "https://zh.wikisource.org/zh-hant/三國志/卷54", supports: "周瑜暂留袁术、任居巢长以及建安三年回归孙策；鲁肃早期在淮南。" }
  ],
  simplifications: [
    ...historicalNotes,
    "河西郡府以尹奉与敦煌为操作代表，酒泉、张掖并入地方联合阵营，并不表示尹奉真实统辖全部河西。张猛此时仅作为地方官吏登场，未提前采用其206年或209年杀邯郸商的局面。",
    "南匈奴诸部用云中、雁门表示北边活动区；其单于及部众并非在196年完整占有两郡。公孙瓒的易京在地图中并入中山节点。",
    "郭汜与李傕关系破裂；本剧本仍以一个关中余部阵营承载人物，避免单城拆为多个阵营。段煨另立弘农。",
    "泰山诸将、豫章郡府及幽州抗瓒诸部以联盟或名义隶属合并。武都入张鲁、上庸入刘表仅为边区经营关系抽象。",
    "荆南的金旋、韩玄、赵范、刘度以及部分南中官吏任职年代晚于或不明于196年，均在列传注明提前配置；这些不是196年官员名单的学术复原。",
    "刘备在196年内数度依附与转移，各纪传时间衔接有差异；小沛开局选取其与吕布暂时和解的可玩阶段。",
    "曹豹、严纲、于毒等明确早亡者不列入开局；人物能力与本游戏职级均为原创数值，不移用商业游戏数据库。",
    "初始友好与盟约按诸侯大势作游戏化表达，盟约期限不是史籍所载的真实合同日期。"
  ],
  counts: { cities: cities.length, factions: factions.length, historicalOfficers: officers.length, fictionalOfficers: 0, freeOfficers: officers.filter((o) => o.status === "free").length, unstaffedCities: cities.filter((city) => !city.officerIds.length).length }
};

for (const [filename, value] of [["scenario.json", scenario], ["officer-bios.json", biographies], ["scenario-notes.json", notes]]) {
  await writeFile(new URL(`src/data/${filename}`, root), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(JSON.stringify(notes.counts));
