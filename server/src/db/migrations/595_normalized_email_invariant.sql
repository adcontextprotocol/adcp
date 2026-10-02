-- Self-contained on main's schema. Operational allocation: 591 -> 592 -> 593 ->
-- unpublished 594 -> 595. Do not renumber without coordinator direction.
-- Exact workos_user_id is the owner; canonical siblings are different owners.
-- One user's credential email and ONE of that same credential's aliases may
-- overlap, as required by the 592 primary-email swap's UPDATE-before-DELETE.
-- Alias verification status confers no authentication authority.
--
-- Installation is transactional under the repository runner. Ambiguous legacy
-- data aborts installation, retaining every original row. Inventory with:
--   npx tsx server/src/scripts/audit-normalized-emails.ts
-- No honest data rollback exists: removing enforcement reopens the race. See
-- specs/normalized-email-invariant.md for custody, restore and rollback policy.

DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Normalized email invariant requires UTF8 storage';
  END IF;
END $$;

-- All cooperating DML uses a separate two-int advisory namespace, disjoint
-- from migration 592's one-bigint credential locks. Never wait while holding
-- a tuple/credential lock, including in arbitrary multi-statement callers.
DO $$ BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(6827, 595) THEN
    RAISE EXCEPTION 'Normalized email invariant is busy' USING ERRCODE = '55P03';
  END IF;
END $$;
-- Installation also fails promptly instead of reversing an existing writer's
-- table/advisory order. Drain writers and retry the entire migration on 55P03.
LOCK TABLE public.users, public.user_email_aliases IN ACCESS EXCLUSIVE MODE NOWAIT;

-- BEGIN GENERATED NORMALIZATION (Unicode 17.0; scripts/generate-email-normalization.mjs)
CREATE OR REPLACE FUNCTION public.normalized_credential_email(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $normalize$
DECLARE
  original TEXT := pg_catalog.btrim(value, pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) || pg_catalog.chr(12) || pg_catalog.chr(13) || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760) || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) || pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197) || pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200) || pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232) || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287) || pg_catalog.chr(12288) || pg_catalog.chr(65279));
  result TEXT := '';
  ch TEXT;
  mapped TEXT;
  point INTEGER;
  position INTEGER;
  following INTEGER;
  previous_cased BOOLEAN := FALSE;
  next_cased BOOLEAN;
  cased CONSTANT pg_catalog.int4multirange := '{[65,91),[97,123),[170,171),[181,182),[186,187),[192,215),[216,247),[248,443),[444,448),[452,660),[662,697),[704,706),[736,741),[837,838),[880,884),[886,888),[890,894),[895,896),[902,903),[904,907),[908,909),[910,930),[931,1014),[1015,1154),[1162,1328),[1329,1367),[1376,1417),[4256,4294),[4295,4296),[4301,4302),[4304,4347),[4348,4352),[5024,5110),[5112,5118),[7296,7307),[7312,7355),[7357,7360),[7424,7616),[7680,7958),[7960,7966),[7968,8006),[8008,8014),[8016,8024),[8025,8026),[8027,8028),[8029,8030),[8031,8062),[8064,8117),[8118,8125),[8126,8127),[8130,8133),[8134,8141),[8144,8148),[8150,8156),[8160,8173),[8178,8181),[8182,8189),[8305,8306),[8319,8320),[8336,8349),[8450,8451),[8455,8456),[8458,8468),[8469,8470),[8473,8478),[8484,8485),[8486,8487),[8488,8489),[8490,8494),[8495,8501),[8505,8506),[8508,8512),[8517,8522),[8526,8527),[8544,8576),[8579,8581),[9398,9450),[11264,11493),[11499,11503),[11506,11508),[11520,11558),[11559,11560),[11565,11566),[42560,42606),[42624,42654),[42786,42888),[42891,42895),[42896,42973),[42993,42999),[43000,43003),[43824,43867),[43868,43882),[43888,43968),[64256,64263),[64275,64280),[65313,65339),[65345,65371),[66560,66640),[66736,66772),[66776,66812),[66928,66939),[66940,66955),[66956,66963),[66964,66966),[66967,66978),[66979,66994),[66995,67002),[67003,67005),[67456,67457),[67459,67462),[67463,67505),[67506,67515),[68736,68787),[68800,68851),[68944,68966),[68976,68998),[71840,71904),[93760,93824),[93856,93881),[93883,93908),[119808,119893),[119894,119965),[119966,119968),[119970,119971),[119973,119975),[119977,119981),[119982,119994),[119995,119996),[119997,120004),[120005,120070),[120071,120075),[120077,120085),[120086,120093),[120094,120122),[120123,120127),[120128,120133),[120134,120135),[120138,120145),[120146,120486),[120488,120513),[120514,120539),[120540,120571),[120572,120597),[120598,120629),[120630,120655),[120656,120687),[120688,120713),[120714,120745),[120746,120771),[120772,120780),[122624,122634),[122635,122655),[122661,122667),[122928,122990),[125184,125252),[127280,127306),[127312,127338),[127344,127370)}'::pg_catalog.int4multirange;
  ignorable CONSTANT pg_catalog.int4multirange := '{[39,40),[46,47),[58,59),[94,95),[96,97),[168,169),[173,174),[175,176),[180,181),[183,185),[688,880),[884,886),[890,891),[900,902),[903,904),[1155,1162),[1369,1370),[1375,1376),[1425,1470),[1471,1472),[1473,1475),[1476,1478),[1479,1480),[1524,1525),[1536,1542),[1552,1563),[1564,1565),[1600,1601),[1611,1632),[1648,1649),[1750,1758),[1759,1769),[1770,1774),[1807,1808),[1809,1810),[1840,1867),[1958,1969),[2027,2038),[2042,2043),[2045,2046),[2070,2094),[2137,2140),[2184,2185),[2192,2194),[2199,2208),[2249,2307),[2362,2363),[2364,2365),[2369,2377),[2381,2382),[2385,2392),[2402,2404),[2417,2418),[2433,2434),[2492,2493),[2497,2501),[2509,2510),[2530,2532),[2558,2559),[2561,2563),[2620,2621),[2625,2627),[2631,2633),[2635,2638),[2641,2642),[2672,2674),[2677,2678),[2689,2691),[2748,2749),[2753,2758),[2759,2761),[2765,2766),[2786,2788),[2810,2816),[2817,2818),[2876,2877),[2879,2880),[2881,2885),[2893,2894),[2901,2903),[2914,2916),[2946,2947),[3008,3009),[3021,3022),[3072,3073),[3076,3077),[3132,3133),[3134,3137),[3142,3145),[3146,3150),[3157,3159),[3170,3172),[3201,3202),[3260,3261),[3263,3264),[3270,3271),[3276,3278),[3298,3300),[3328,3330),[3387,3389),[3393,3397),[3405,3406),[3426,3428),[3457,3458),[3530,3531),[3538,3541),[3542,3543),[3633,3634),[3636,3643),[3654,3663),[3761,3762),[3764,3773),[3782,3783),[3784,3791),[3864,3866),[3893,3894),[3895,3896),[3897,3898),[3953,3967),[3968,3973),[3974,3976),[3981,3992),[3993,4029),[4038,4039),[4141,4145),[4146,4152),[4153,4155),[4157,4159),[4184,4186),[4190,4193),[4209,4213),[4226,4227),[4229,4231),[4237,4238),[4253,4254),[4348,4349),[4957,4960),[5906,5909),[5938,5940),[5970,5972),[6002,6004),[6068,6070),[6071,6078),[6086,6087),[6089,6100),[6103,6104),[6109,6110),[6155,6160),[6211,6212),[6277,6279),[6313,6314),[6432,6435),[6439,6441),[6450,6451),[6457,6460),[6679,6681),[6683,6684),[6742,6743),[6744,6751),[6752,6753),[6754,6755),[6757,6765),[6771,6781),[6783,6784),[6823,6824),[6832,6878),[6880,6892),[6912,6916),[6964,6965),[6966,6971),[6972,6973),[6978,6979),[7019,7028),[7040,7042),[7074,7078),[7080,7082),[7083,7086),[7142,7143),[7144,7146),[7149,7150),[7151,7154),[7212,7220),[7222,7224),[7288,7294),[7376,7379),[7380,7393),[7394,7401),[7405,7406),[7412,7413),[7416,7418),[7468,7531),[7544,7545),[7579,7680),[8125,8126),[8127,8130),[8141,8144),[8157,8160),[8173,8176),[8189,8191),[8203,8208),[8216,8218),[8228,8229),[8231,8232),[8234,8239),[8288,8293),[8294,8304),[8305,8306),[8319,8320),[8336,8349),[8400,8433),[11388,11390),[11503,11506),[11631,11632),[11647,11648),[11744,11776),[11823,11824),[12293,12294),[12330,12334),[12337,12342),[12347,12348),[12441,12447),[12540,12543),[40981,40982),[42232,42238),[42508,42509),[42607,42611),[42612,42622),[42623,42624),[42652,42656),[42736,42738),[42752,42786),[42864,42865),[42888,42891),[42993,42997),[43000,43002),[43010,43011),[43014,43015),[43019,43020),[43045,43047),[43052,43053),[43204,43206),[43232,43250),[43263,43264),[43302,43310),[43335,43346),[43392,43395),[43443,43444),[43446,43450),[43452,43454),[43471,43472),[43493,43495),[43561,43567),[43569,43571),[43573,43575),[43587,43588),[43596,43597),[43632,43633),[43644,43645),[43696,43697),[43698,43701),[43703,43705),[43710,43712),[43713,43714),[43741,43742),[43756,43758),[43763,43765),[43766,43767),[43867,43872),[43881,43884),[44005,44006),[44008,44009),[44013,44014),[64286,64287),[64434,64451),[65024,65040),[65043,65044),[65056,65072),[65106,65107),[65109,65110),[65279,65280),[65287,65288),[65294,65295),[65306,65307),[65342,65343),[65344,65345),[65392,65393),[65438,65440),[65507,65508),[65529,65532),[66045,66046),[66272,66273),[66422,66427),[67456,67462),[67463,67505),[67506,67515),[68097,68100),[68101,68103),[68108,68112),[68152,68155),[68159,68160),[68325,68327),[68900,68904),[68942,68943),[68969,68974),[68975,68976),[69291,69293),[69317,69318),[69370,69376),[69446,69457),[69506,69510),[69633,69634),[69688,69703),[69744,69745),[69747,69749),[69759,69762),[69811,69815),[69817,69819),[69821,69822),[69826,69827),[69837,69838),[69888,69891),[69927,69932),[69933,69941),[70003,70004),[70016,70018),[70070,70079),[70089,70093),[70095,70096),[70191,70194),[70196,70197),[70198,70200),[70206,70207),[70209,70210),[70367,70368),[70371,70379),[70400,70402),[70459,70461),[70464,70465),[70502,70509),[70512,70517),[70587,70593),[70606,70607),[70608,70609),[70610,70611),[70625,70627),[70712,70720),[70722,70725),[70726,70727),[70750,70751),[70835,70841),[70842,70843),[70847,70849),[70850,70852),[71090,71094),[71100,71102),[71103,71105),[71132,71134),[71219,71227),[71229,71230),[71231,71233),[71339,71340),[71341,71342),[71344,71350),[71351,71352),[71453,71454),[71455,71456),[71458,71462),[71463,71468),[71727,71736),[71737,71739),[71995,71997),[71998,71999),[72003,72004),[72148,72152),[72154,72156),[72160,72161),[72193,72203),[72243,72249),[72251,72255),[72263,72264),[72273,72279),[72281,72284),[72330,72343),[72344,72346),[72544,72545),[72546,72549),[72550,72551),[72752,72759),[72760,72766),[72767,72768),[72850,72872),[72874,72881),[72882,72884),[72885,72887),[73009,73015),[73018,73019),[73020,73022),[73023,73030),[73031,73032),[73104,73106),[73109,73110),[73111,73112),[73177,73178),[73459,73461),[73472,73474),[73526,73531),[73536,73537),[73538,73539),[73562,73563),[78896,78913),[78919,78934),[90398,90410),[90413,90416),[92912,92917),[92976,92983),[92992,92996),[93504,93507),[93547,93549),[94031,94032),[94095,94112),[94176,94178),[94179,94181),[94194,94196),[110576,110580),[110581,110588),[110589,110591),[113821,113823),[113824,113828),[118528,118574),[118576,118599),[119143,119146),[119155,119171),[119173,119180),[119210,119214),[119362,119365),[121344,121399),[121403,121453),[121461,121462),[121476,121477),[121499,121504),[121505,121520),[122880,122887),[122888,122905),[122907,122914),[122915,122917),[122918,122923),[122928,122990),[123023,123024),[123184,123198),[123566,123567),[123628,123632),[124139,124144),[124398,124400),[124643,124644),[124646,124647),[124654,124656),[124661,124662),[124671,124672),[125136,125143),[125252,125260),[127995,128000),[917505,917506),[917536,917632),[917760,918000)}'::pg_catalog.int4multirange;
BEGIN
  -- Locale-independent ASCII fast path (the usual production address).
  IF pg_catalog.octet_length(original) = pg_catalog.char_length(original) THEN
    RETURN pg_catalog.translate(original, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  END IF;
  FOR position IN 1..pg_catalog.char_length(original) LOOP
    ch := pg_catalog.substr(original, position, 1);
    point := pg_catalog.ascii(ch);
    IF point = 931 AND previous_cased THEN
      next_cased := FALSE;
      FOR following IN position + 1..pg_catalog.char_length(original) LOOP
        point := pg_catalog.ascii(pg_catalog.substr(original, following, 1));
        IF ignorable @> point THEN CONTINUE; END IF;
        next_cased := cased @> point;
        EXIT;
      END LOOP;
      mapped := CASE WHEN next_cased THEN 'σ' ELSE 'ς' END;
    ELSIF point = 304 THEN
      mapped := U&'i\0307';
    ELSE
      mapped := pg_catalog.translate(ch, 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞĀĂĄĆĈĊČĎĐĒĔĖĘĚĜĞĠĢĤĦĨĪĬĮĲĴĶĹĻĽĿŁŃŅŇŊŌŎŐŒŔŖŘŚŜŞŠŢŤŦŨŪŬŮŰŲŴŶŸŹŻŽƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠƢƤƦƧƩƬƮƯƱƲƳƵƷƸƼǄǅǇǈǊǋǍǏǑǓǕǗǙǛǞǠǢǤǦǨǪǬǮǱǲǴǶǷǸǺǼǾȀȂȄȆȈȊȌȎȐȒȔȖȘȚȜȞȠȢȤȦȨȪȬȮȰȲȺȻȽȾɁɃɄɅɆɈɊɌɎͰͲͶͿΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫϏϘϚϜϞϠϢϤϦϨϪϬϮϴϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯѠѢѤѦѨѪѬѮѰѲѴѶѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӃӅӇӉӋӍӐӒӔӖӘӚӜӞӠӢӤӦӨӪӬӮӰӲӴӶӸӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍᎠᎡᎢᎣᎤᎥᎦᎧᎨᎩᎪᎫᎬᎭᎮᎯᎰᎱᎲᎳᎴᎵᎶᎷᎸᎹᎺᎻᎼᎽᎾᎿᏀᏁᏂᏃᏄᏅᏆᏇᏈᏉᏊᏋᏌᏍᏎᏏᏐᏑᏒᏓᏔᏕᏖᏗᏘᏙᏚᏛᏜᏝᏞᏟᏠᏡᏢᏣᏤᏥᏦᏧᏨᏩᏪᏫᏬᏭᏮᏯᏰᏱᏲᏳᏴᏵᲉᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿḀḂḄḆḈḊḌḎḐḒḔḖḘḚḜḞḠḢḤḦḨḪḬḮḰḲḴḶḸḺḼḾṀṂṄṆṈṊṌṎṐṒṔṖṘṚṜṞṠṢṤṦṨṪṬṮṰṲṴṶṸṺṼṾẀẂẄẆẈẊẌẎẐẒẔẞẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỬỮỰỲỴỶỸỺỼỾἈἉἊἋἌἍἎἏἘἙἚἛἜἝἨἩἪἫἬἭἮἯἸἹἺἻἼἽἾἿὈὉὊὋὌὍὙὛὝὟὨὩὪὫὬὭὮὯᾈᾉᾊᾋᾌᾍᾎᾏᾘᾙᾚᾛᾜᾝᾞᾟᾨᾩᾪᾫᾬᾭᾮᾯᾸᾹᾺΆᾼῈΈῊΉῌῘῙῚΊῨῩῪΎῬῸΌῺΏῼΩKÅℲⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯↃⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟋꟌ꟎Ꟑ꟒꟔ꟖꟘꟚꟜꟵＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇𐐈𐐉𐐊𐐋𐐌𐐍𐐎𐐏𐐐𐐑𐐒𐐓𐐔𐐕𐐖𐐗𐐘𐐙𐐚𐐛𐐜𐐝𐐞𐐟𐐠𐐡𐐢𐐣𐐤𐐥𐐦𐐧𐒰𐒱𐒲𐒳𐒴𐒵𐒶𐒷𐒸𐒹𐒺𐒻𐒼𐒽𐒾𐒿𐓀𐓁𐓂𐓃𐓄𐓅𐓆𐓇𐓈𐓉𐓊𐓋𐓌𐓍𐓎𐓏𐓐𐓑𐓒𐓓𐕰𐕱𐕲𐕳𐕴𐕵𐕶𐕷𐕸𐕹𐕺𐕼𐕽𐕾𐕿𐖀𐖁𐖂𐖃𐖄𐖅𐖆𐖇𐖈𐖉𐖊𐖌𐖍𐖎𐖏𐖐𐖑𐖒𐖔𐖕𐲀𐲁𐲂𐲃𐲄𐲅𐲆𐲇𐲈𐲉𐲊𐲋𐲌𐲍𐲎𐲏𐲐𐲑𐲒𐲓𐲔𐲕𐲖𐲗𐲘𐲙𐲚𐲛𐲜𐲝𐲞𐲟𐲠𐲡𐲢𐲣𐲤𐲥𐲦𐲧𐲨𐲩𐲪𐲫𐲬𐲭𐲮𐲯𐲰𐲱𐲲𐵐𐵑𐵒𐵓𐵔𐵕𐵖𐵗𐵘𐵙𐵚𐵛𐵜𐵝𐵞𐵟𐵠𐵡𐵢𐵣𐵤𐵥𑢠𑢡𑢢𑢣𑢤𑢥𑢦𑢧𑢨𑢩𑢪𑢫𑢬𑢭𑢮𑢯𑢰𑢱𑢲𑢳𑢴𑢵𑢶𑢷𑢸𑢹𑢺𑢻𑢼𑢽𑢾𑢿𖹀𖹁𖹂𖹃𖹄𖹅𖹆𖹇𖹈𖹉𖹊𖹋𖹌𖹍𖹎𖹏𖹐𖹑𖹒𖹓𖹔𖹕𖹖𖹗𖹘𖹙𖹚𖹛𖹜𖹝𖹞𖹟𖺠𖺡𖺢𖺣𖺤𖺥𖺦𖺧𖺨𖺩𖺪𖺫𖺬𖺭𖺮𖺯𖺰𖺱𖺲𖺳𖺴𖺵𖺶𖺷𖺸𞤀𞤁𞤂𞤃𞤄𞤅𞤆𞤇𞤈𞤉𞤊𞤋𞤌𞤍𞤎𞤏𞤐𞤑𞤒𞤓𞤔𞤕𞤖𞤗𞤘𞤙𞤚𞤛𞤜𞤝𞤞𞤟𞤠𞤡', 'abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįĳĵķĺļľŀłńņňŋōŏőœŕŗřśŝşšţťŧũūŭůűųŵŷÿźżžɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵơƣƥʀƨʃƭʈưʊʋƴƶʒƹƽǆǆǉǉǌǌǎǐǒǔǖǘǚǜǟǡǣǥǧǩǫǭǯǳǳǵƕƿǹǻǽǿȁȃȅȇȉȋȍȏȑȓȕȗșțȝȟƞȣȥȧȩȫȭȯȱȳⱥȼƚⱦɂƀʉʌɇɉɋɍɏͱͳͷϳάέήίόύώαβγδεζηθικλμνξοπρστυφχψωϊϋϗϙϛϝϟϡϣϥϧϩϫϭϯθϸϲϻͻͼͽѐёђѓєѕіїјљњћќѝўџабвгдежзийклмнопрстуфхцчшщъыьэюяѡѣѥѧѩѫѭѯѱѳѵѷѹѻѽѿҁҋҍҏґғҕҗҙқҝҟҡңҥҧҩҫҭүұҳҵҷҹһҽҿӏӂӄӆӈӊӌӎӑӓӕӗәӛӝӟӡӣӥӧөӫӭӯӱӳӵӷӹӻӽӿԁԃԅԇԉԋԍԏԑԓԕԗԙԛԝԟԡԣԥԧԩԫԭԯաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆⴀⴁⴂⴃⴄⴅⴆⴇⴈⴉⴊⴋⴌⴍⴎⴏⴐⴑⴒⴓⴔⴕⴖⴗⴘⴙⴚⴛⴜⴝⴞⴟⴠⴡⴢⴣⴤⴥⴧⴭꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿᏸᏹᏺᏻᏼᏽᲊაბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰჱჲჳჴჵჶჷჸჹჺჽჾჿḁḃḅḇḉḋḍḏḑḓḕḗḙḛḝḟḡḣḥḧḩḫḭḯḱḳḵḷḹḻḽḿṁṃṅṇṉṋṍṏṑṓṕṗṙṛṝṟṡṣṥṧṩṫṭṯṱṳṵṷṹṻṽṿẁẃẅẇẉẋẍẏẑẓẕßạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹỻỽỿἀἁἂἃἄἅἆἇἐἑἒἓἔἕἠἡἢἣἤἥἦἧἰἱἲἳἴἵἶἷὀὁὂὃὄὅὑὓὕὗὠὡὢὣὤὥὦὧᾀᾁᾂᾃᾄᾅᾆᾇᾐᾑᾒᾓᾔᾕᾖᾗᾠᾡᾢᾣᾤᾥᾦᾧᾰᾱὰάᾳὲέὴήῃῐῑὶίῠῡὺύῥὸόὼώῳωkåⅎⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿↄⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩⰰⰱⰲⰳⰴⰵⰶⰷⰸⰹⰺⰻⰼⰽⰾⰿⱀⱁⱂⱃⱄⱅⱆⱇⱈⱉⱊⱋⱌⱍⱎⱏⱐⱑⱒⱓⱔⱕⱖⱗⱘⱙⱚⱛⱜⱝⱞⱟⱡɫᵽɽⱨⱪⱬɑɱɐɒⱳⱶȿɀⲁⲃⲅⲇⲉⲋⲍⲏⲑⲓⲕⲗⲙⲛⲝⲟⲡⲣⲥⲧⲩⲫⲭⲯⲱⲳⲵⲷⲹⲻⲽⲿⳁⳃⳅⳇⳉⳋⳍⳏⳑⳓⳕⳗⳙⳛⳝⳟⳡⳣⳬⳮⳳꙁꙃꙅꙇꙉꙋꙍꙏꙑꙓꙕꙗꙙꙛꙝꙟꙡꙣꙥꙧꙩꙫꙭꚁꚃꚅꚇꚉꚋꚍꚏꚑꚓꚕꚗꚙꚛꜣꜥꜧꜩꜫꜭꜯꜳꜵꜷꜹꜻꜽꜿꝁꝃꝅꝇꝉꝋꝍꝏꝑꝓꝕꝗꝙꝛꝝꝟꝡꝣꝥꝧꝩꝫꝭꝯꝺꝼᵹꝿꞁꞃꞅꞇꞌɥꞑꞓꞗꞙꞛꞝꞟꞡꞣꞥꞧꞩɦɜɡɬɪʞʇʝꭓꞵꞷꞹꞻꞽꞿꟁꟃꞔʂᶎꟈꟊɤꟍ꟏ꟑꟓꟕꟗꟙꟛƛꟶａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ𐐨𐐩𐐪𐐫𐐬𐐭𐐮𐐯𐐰𐐱𐐲𐐳𐐴𐐵𐐶𐐷𐐸𐐹𐐺𐐻𐐼𐐽𐐾𐐿𐑀𐑁𐑂𐑃𐑄𐑅𐑆𐑇𐑈𐑉𐑊𐑋𐑌𐑍𐑎𐑏𐓘𐓙𐓚𐓛𐓜𐓝𐓞𐓟𐓠𐓡𐓢𐓣𐓤𐓥𐓦𐓧𐓨𐓩𐓪𐓫𐓬𐓭𐓮𐓯𐓰𐓱𐓲𐓳𐓴𐓵𐓶𐓷𐓸𐓹𐓺𐓻𐖗𐖘𐖙𐖚𐖛𐖜𐖝𐖞𐖟𐖠𐖡𐖣𐖤𐖥𐖦𐖧𐖨𐖩𐖪𐖫𐖬𐖭𐖮𐖯𐖰𐖱𐖳𐖴𐖵𐖶𐖷𐖸𐖹𐖻𐖼𐳀𐳁𐳂𐳃𐳄𐳅𐳆𐳇𐳈𐳉𐳊𐳋𐳌𐳍𐳎𐳏𐳐𐳑𐳒𐳓𐳔𐳕𐳖𐳗𐳘𐳙𐳚𐳛𐳜𐳝𐳞𐳟𐳠𐳡𐳢𐳣𐳤𐳥𐳦𐳧𐳨𐳩𐳪𐳫𐳬𐳭𐳮𐳯𐳰𐳱𐳲𐵰𐵱𐵲𐵳𐵴𐵵𐵶𐵷𐵸𐵹𐵺𐵻𐵼𐵽𐵾𐵿𐶀𐶁𐶂𐶃𐶄𐶅𑣀𑣁𑣂𑣃𑣄𑣅𑣆𑣇𑣈𑣉𑣊𑣋𑣌𑣍𑣎𑣏𑣐𑣑𑣒𑣓𑣔𑣕𑣖𑣗𑣘𑣙𑣚𑣛𑣜𑣝𑣞𑣟𖹠𖹡𖹢𖹣𖹤𖹥𖹦𖹧𖹨𖹩𖹪𖹫𖹬𖹭𖹮𖹯𖹰𖹱𖹲𖹳𖹴𖹵𖹶𖹷𖹸𖹹𖹺𖹻𖹼𖹽𖹾𖹿𖺻𖺼𖺽𖺾𖺿𖻀𖻁𖻂𖻃𖻄𖻅𖻆𖻇𖻈𖻉𖻊𖻋𖻌𖻍𖻎𖻏𖻐𖻑𖻒𖻓𞤢𞤣𞤤𞤥𞤦𞤧𞤨𞤩𞤪𞤫𞤬𞤭𞤮𞤯𞤰𞤱𞤲𞤳𞤴𞤵𞤶𞤷𞤸𞤹𞤺𞤻𞤼𞤽𞤾𞤿𞥀𞥁𞥂𞥃');
    END IF;
    result := result || mapped;
    point := pg_catalog.ascii(ch);
    IF NOT (ignorable @> point) THEN previous_cased := cased @> point; END IF;
  END LOOP;
  RETURN result;
END;
$normalize$;
-- END GENERATED NORMALIZATION

CREATE TABLE IF NOT EXISTS public.normalized_email_serialization (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO public.normalized_email_serialization(singleton)
VALUES (TRUE) ON CONFLICT DO NOTHING;
REVOKE ALL ON public.normalized_email_serialization FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.check_normalized_email_invariant()
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  conflict_count BIGINT;
  evidence JSONB;
BEGIN
  WITH representations AS (
    SELECT public.normalized_credential_email(email) COLLATE "C" AS normalized_email,
      workos_user_id COLLATE "C" AS owner, 'users' AS source,
      workos_user_id::TEXT AS row_id, email::TEXT AS original_email
    FROM public.users
    UNION ALL
    SELECT public.normalized_credential_email(email) COLLATE "C",
      workos_user_id COLLATE "C", 'user_email_aliases', id::TEXT, email::TEXT
    FROM public.user_email_aliases
  ), conflicts AS (
    SELECT normalized_email,
      jsonb_agg(jsonb_build_object('source', source, 'id', row_id,
        'owner', owner, 'email', original_email) ORDER BY source, row_id) AS rows
    FROM representations GROUP BY normalized_email
    HAVING count(DISTINCT owner) > 1
      OR count(*) FILTER (WHERE source = 'user_email_aliases') > 1
  )
  SELECT (SELECT count(*) FROM conflicts),
    (SELECT jsonb_agg(to_jsonb(sample)) FROM
      (SELECT * FROM conflicts ORDER BY normalized_email LIMIT 20) sample)
  INTO conflict_count, evidence;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Normalized email invariant conflict (% keys)', conflict_count
      USING ERRCODE = '23505', CONSTRAINT = 'normalized_email_owner',
        DETAIL = evidence::TEXT,
        HINT = 'Retain all rows. Run audit-normalized-emails.ts with read-only credentials; resolve provenance with support before retrying. No automatic winner is safe.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.check_normalized_email_invariant() FROM PUBLIC;

-- Fail installation before introducing enforcement over ambiguous history.
SELECT public.check_normalized_email_invariant();

CREATE OR REPLACE FUNCTION public.lock_normalized_email_writer()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  affected BIGINT;
  generation BIGINT;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(6827, 595) THEN
    RAISE EXCEPTION 'Normalized email invariant is busy' USING ERRCODE = '55P03';
  END IF;
  -- A lock alone cannot refresh a REPEATABLE READ snapshot. Every writer
  -- writes this row: a stale snapshot fails with 40001 before checking data.
  UPDATE public.normalized_email_serialization SET version = version + 1
    WHERE singleton RETURNING version INTO generation;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 OR generation IS NULL THEN
    RAISE EXCEPTION 'Normalized email serialization evidence missing' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_normalized_email_writer() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.verify_normalized_email_writer()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
BEGIN
  PERFORM public.check_normalized_email_invariant();
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_normalized_email_writer() FROM PUBLIC;

-- All UPDATEs participate: another row trigger can change email even when
-- the original SET list does not mention it. No recursion-depth bypass.
DROP TRIGGER IF EXISTS lock_normalized_email_writer ON public.users;
CREATE TRIGGER lock_normalized_email_writer
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.users
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_normalized_email_writer();
DROP TRIGGER IF EXISTS verify_normalized_email_writer ON public.users;
CREATE TRIGGER verify_normalized_email_writer
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.users
  FOR EACH STATEMENT EXECUTE FUNCTION public.verify_normalized_email_writer();
DROP TRIGGER IF EXISTS lock_normalized_email_writer ON public.user_email_aliases;
CREATE TRIGGER lock_normalized_email_writer
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.user_email_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_normalized_email_writer();
DROP TRIGGER IF EXISTS verify_normalized_email_writer ON public.user_email_aliases;
CREATE TRIGGER verify_normalized_email_writer
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.user_email_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION public.verify_normalized_email_writer();
ALTER TABLE public.users ENABLE ALWAYS TRIGGER lock_normalized_email_writer;
ALTER TABLE public.users ENABLE ALWAYS TRIGGER verify_normalized_email_writer;
ALTER TABLE public.user_email_aliases ENABLE ALWAYS TRIGGER lock_normalized_email_writer;
ALTER TABLE public.user_email_aliases ENABLE ALWAYS TRIGGER verify_normalized_email_writer;
