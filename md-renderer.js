// © 2026 Joschua Gandert - License: Apache 2.0

/**
 * Zero-dependency client-side Markdown to HTML renderer.
 * Converts markdown (e.g., md-showcase.md) into styled HTML structures.
 *
 * @example Browser Usage:
 * <script src="md-renderer.js"></script>
 * <script>
 *   // Method 1: Fetch and render directly into a DOM container
 *   renderMarkdownFileToElement('md-showcase.md', '#content-container');
 *
 *   // Method 2: Parse raw Markdown string to HTML
 *   const html = parseMarkdownToHTML('# Hello World\nSome text.');
 *   document.getElementById('content-container').innerHTML = html;
 * </script>
 *
 * @example Node.js / Bun Usage:
 * const { parseMarkdownToHTML, renderMarkdownFileToElement } = require('./md-renderer.js');
 * const html = parseMarkdownToHTML('# Title\n\nParagraph text.');
 */

/**
 * Escapes raw HTML characters while preserving existing valid HTML entities.
 * @param {string} str
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    return str
        .replace(/&(?!(?:[a-zA-Z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);)/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeHtmlLiteral(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeHtmlAttribute(str) {
    return escapeHtmlLiteral(str);
}

// HTML named character references from https://html.spec.whatwg.org/entities.json.
// Markdown requires the semicolon; this bundled standards data also works without a DOM.
const MARKDOWN_NAMED_REFERENCES = new Map([
    "AElig:c6 AMP:26 Aacute:c1 Abreve:102 Acirc:c2 Acy:410 Afr:1d504 Agrave:c0 Alpha:391 Amacr:100 And:2a53 Aogon:104",
    "Aopf:1d538 ApplyFunction:2061 Aring:c5 Ascr:1d49c Assign:2254 Atilde:c3 Auml:c4 Backslash:2216 Barv:2ae7 Barwed:2306 Bcy:411 Because:2235",
    "Bernoullis:212c Beta:392 Bfr:1d505 Bopf:1d539 Breve:2d8 Bscr:212c Bumpeq:224e CHcy:427 COPY:a9 Cacute:106 Cap:22d2 CapitalDifferentialD:2145",
    "Cayleys:212d Ccaron:10c Ccedil:c7 Ccirc:108 Cconint:2230 Cdot:10a Cedilla:b8 CenterDot:b7 Cfr:212d Chi:3a7 CircleDot:2299 CircleMinus:2296",
    "CirclePlus:2295 CircleTimes:2297 ClockwiseContourIntegral:2232 CloseCurlyDoubleQuote:201d CloseCurlyQuote:2019 Colon:2237 Colone:2a74 Congruent:2261 Conint:222f ContourIntegral:222e Copf:2102 Coproduct:2210",
    "CounterClockwiseContourIntegral:2233 Cross:2a2f Cscr:1d49e Cup:22d3 CupCap:224d DD:2145 DDotrahd:2911 DJcy:402 DScy:405 DZcy:40f Dagger:2021 Darr:21a1",
    "Dashv:2ae4 Dcaron:10e Dcy:414 Del:2207 Delta:394 Dfr:1d507 DiacriticalAcute:b4 DiacriticalDot:2d9 DiacriticalDoubleAcute:2dd DiacriticalGrave:60 DiacriticalTilde:2dc Diamond:22c4",
    "DifferentialD:2146 Dopf:1d53b Dot:a8 DotDot:20dc DotEqual:2250 DoubleContourIntegral:222f DoubleDot:a8 DoubleDownArrow:21d3 DoubleLeftArrow:21d0 DoubleLeftRightArrow:21d4 DoubleLeftTee:2ae4 DoubleLongLeftArrow:27f8",
    "DoubleLongLeftRightArrow:27fa DoubleLongRightArrow:27f9 DoubleRightArrow:21d2 DoubleRightTee:22a8 DoubleUpArrow:21d1 DoubleUpDownArrow:21d5 DoubleVerticalBar:2225 DownArrow:2193 DownArrowBar:2913 DownArrowUpArrow:21f5 DownBreve:311 DownLeftRightVector:2950",
    "DownLeftTeeVector:295e DownLeftVector:21bd DownLeftVectorBar:2956 DownRightTeeVector:295f DownRightVector:21c1 DownRightVectorBar:2957 DownTee:22a4 DownTeeArrow:21a7 Downarrow:21d3 Dscr:1d49f Dstrok:110 ENG:14a",
    "ETH:d0 Eacute:c9 Ecaron:11a Ecirc:ca Ecy:42d Edot:116 Efr:1d508 Egrave:c8 Element:2208 Emacr:112 EmptySmallSquare:25fb EmptyVerySmallSquare:25ab",
    "Eogon:118 Eopf:1d53c Epsilon:395 Equal:2a75 EqualTilde:2242 Equilibrium:21cc Escr:2130 Esim:2a73 Eta:397 Euml:cb Exists:2203 ExponentialE:2147",
    "Fcy:424 Ffr:1d509 FilledSmallSquare:25fc FilledVerySmallSquare:25aa Fopf:1d53d ForAll:2200 Fouriertrf:2131 Fscr:2131 GJcy:403 GT:3e Gamma:393 Gammad:3dc",
    "Gbreve:11e Gcedil:122 Gcirc:11c Gcy:413 Gdot:120 Gfr:1d50a Gg:22d9 Gopf:1d53e GreaterEqual:2265 GreaterEqualLess:22db GreaterFullEqual:2267 GreaterGreater:2aa2",
    "GreaterLess:2277 GreaterSlantEqual:2a7e GreaterTilde:2273 Gscr:1d4a2 Gt:226b HARDcy:42a Hacek:2c7 Hat:5e Hcirc:124 Hfr:210c HilbertSpace:210b Hopf:210d",
    "HorizontalLine:2500 Hscr:210b Hstrok:126 HumpDownHump:224e HumpEqual:224f IEcy:415 IJlig:132 IOcy:401 Iacute:cd Icirc:ce Icy:418 Idot:130",
    "Ifr:2111 Igrave:cc Im:2111 Imacr:12a ImaginaryI:2148 Implies:21d2 Int:222c Integral:222b Intersection:22c2 InvisibleComma:2063 InvisibleTimes:2062 Iogon:12e",
    "Iopf:1d540 Iota:399 Iscr:2110 Itilde:128 Iukcy:406 Iuml:cf Jcirc:134 Jcy:419 Jfr:1d50d Jopf:1d541 Jscr:1d4a5 Jsercy:408",
    "Jukcy:404 KHcy:425 KJcy:40c Kappa:39a Kcedil:136 Kcy:41a Kfr:1d50e Kopf:1d542 Kscr:1d4a6 LJcy:409 LT:3c Lacute:139",
    "Lambda:39b Lang:27ea Laplacetrf:2112 Larr:219e Lcaron:13d Lcedil:13b Lcy:41b LeftAngleBracket:27e8 LeftArrow:2190 LeftArrowBar:21e4 LeftArrowRightArrow:21c6 LeftCeiling:2308",
    "LeftDoubleBracket:27e6 LeftDownTeeVector:2961 LeftDownVector:21c3 LeftDownVectorBar:2959 LeftFloor:230a LeftRightArrow:2194 LeftRightVector:294e LeftTee:22a3 LeftTeeArrow:21a4 LeftTeeVector:295a LeftTriangle:22b2 LeftTriangleBar:29cf",
    "LeftTriangleEqual:22b4 LeftUpDownVector:2951 LeftUpTeeVector:2960 LeftUpVector:21bf LeftUpVectorBar:2958 LeftVector:21bc LeftVectorBar:2952 Leftarrow:21d0 Leftrightarrow:21d4 LessEqualGreater:22da LessFullEqual:2266 LessGreater:2276",
    "LessLess:2aa1 LessSlantEqual:2a7d LessTilde:2272 Lfr:1d50f Ll:22d8 Lleftarrow:21da Lmidot:13f LongLeftArrow:27f5 LongLeftRightArrow:27f7 LongRightArrow:27f6 Longleftarrow:27f8 Longleftrightarrow:27fa",
    "Longrightarrow:27f9 Lopf:1d543 LowerLeftArrow:2199 LowerRightArrow:2198 Lscr:2112 Lsh:21b0 Lstrok:141 Lt:226a Map:2905 Mcy:41c MediumSpace:205f Mellintrf:2133",
    "Mfr:1d510 MinusPlus:2213 Mopf:1d544 Mscr:2133 Mu:39c NJcy:40a Nacute:143 Ncaron:147 Ncedil:145 Ncy:41d NegativeMediumSpace:200b NegativeThickSpace:200b",
    "NegativeThinSpace:200b NegativeVeryThinSpace:200b NestedGreaterGreater:226b NestedLessLess:226a NewLine:a Nfr:1d511 NoBreak:2060 NonBreakingSpace:a0 Nopf:2115 Not:2aec NotCongruent:2262 NotCupCap:226d",
    "NotDoubleVerticalBar:2226 NotElement:2209 NotEqual:2260 NotEqualTilde:2242:338 NotExists:2204 NotGreater:226f NotGreaterEqual:2271 NotGreaterFullEqual:2267:338 NotGreaterGreater:226b:338 NotGreaterLess:2279 NotGreaterSlantEqual:2a7e:338 NotGreaterTilde:2275",
    "NotHumpDownHump:224e:338 NotHumpEqual:224f:338 NotLeftTriangle:22ea NotLeftTriangleBar:29cf:338 NotLeftTriangleEqual:22ec NotLess:226e NotLessEqual:2270 NotLessGreater:2278 NotLessLess:226a:338 NotLessSlantEqual:2a7d:338 NotLessTilde:2274 NotNestedGreaterGreater:2aa2:338",
    "NotNestedLessLess:2aa1:338 NotPrecedes:2280 NotPrecedesEqual:2aaf:338 NotPrecedesSlantEqual:22e0 NotReverseElement:220c NotRightTriangle:22eb NotRightTriangleBar:29d0:338 NotRightTriangleEqual:22ed NotSquareSubset:228f:338 NotSquareSubsetEqual:22e2 NotSquareSuperset:2290:338 NotSquareSupersetEqual:22e3",
    "NotSubset:2282:20d2 NotSubsetEqual:2288 NotSucceeds:2281 NotSucceedsEqual:2ab0:338 NotSucceedsSlantEqual:22e1 NotSucceedsTilde:227f:338 NotSuperset:2283:20d2 NotSupersetEqual:2289 NotTilde:2241 NotTildeEqual:2244 NotTildeFullEqual:2247 NotTildeTilde:2249",
    "NotVerticalBar:2224 Nscr:1d4a9 Ntilde:d1 Nu:39d OElig:152 Oacute:d3 Ocirc:d4 Ocy:41e Odblac:150 Ofr:1d512 Ograve:d2 Omacr:14c",
    "Omega:3a9 Omicron:39f Oopf:1d546 OpenCurlyDoubleQuote:201c OpenCurlyQuote:2018 Or:2a54 Oscr:1d4aa Oslash:d8 Otilde:d5 Otimes:2a37 Ouml:d6 OverBar:203e",
    "OverBrace:23de OverBracket:23b4 OverParenthesis:23dc PartialD:2202 Pcy:41f Pfr:1d513 Phi:3a6 Pi:3a0 PlusMinus:b1 Poincareplane:210c Popf:2119 Pr:2abb",
    "Precedes:227a PrecedesEqual:2aaf PrecedesSlantEqual:227c PrecedesTilde:227e Prime:2033 Product:220f Proportion:2237 Proportional:221d Pscr:1d4ab Psi:3a8 QUOT:22 Qfr:1d514",
    "Qopf:211a Qscr:1d4ac RBarr:2910 REG:ae Racute:154 Rang:27eb Rarr:21a0 Rarrtl:2916 Rcaron:158 Rcedil:156 Rcy:420 Re:211c",
    "ReverseElement:220b ReverseEquilibrium:21cb ReverseUpEquilibrium:296f Rfr:211c Rho:3a1 RightAngleBracket:27e9 RightArrow:2192 RightArrowBar:21e5 RightArrowLeftArrow:21c4 RightCeiling:2309 RightDoubleBracket:27e7 RightDownTeeVector:295d",
    "RightDownVector:21c2 RightDownVectorBar:2955 RightFloor:230b RightTee:22a2 RightTeeArrow:21a6 RightTeeVector:295b RightTriangle:22b3 RightTriangleBar:29d0 RightTriangleEqual:22b5 RightUpDownVector:294f RightUpTeeVector:295c RightUpVector:21be",
    "RightUpVectorBar:2954 RightVector:21c0 RightVectorBar:2953 Rightarrow:21d2 Ropf:211d RoundImplies:2970 Rrightarrow:21db Rscr:211b Rsh:21b1 RuleDelayed:29f4 SHCHcy:429 SHcy:428",
    "SOFTcy:42c Sacute:15a Sc:2abc Scaron:160 Scedil:15e Scirc:15c Scy:421 Sfr:1d516 ShortDownArrow:2193 ShortLeftArrow:2190 ShortRightArrow:2192 ShortUpArrow:2191",
    "Sigma:3a3 SmallCircle:2218 Sopf:1d54a Sqrt:221a Square:25a1 SquareIntersection:2293 SquareSubset:228f SquareSubsetEqual:2291 SquareSuperset:2290 SquareSupersetEqual:2292 SquareUnion:2294 Sscr:1d4ae",
    "Star:22c6 Sub:22d0 Subset:22d0 SubsetEqual:2286 Succeeds:227b SucceedsEqual:2ab0 SucceedsSlantEqual:227d SucceedsTilde:227f SuchThat:220b Sum:2211 Sup:22d1 Superset:2283",
    "SupersetEqual:2287 Supset:22d1 THORN:de TRADE:2122 TSHcy:40b TScy:426 Tab:9 Tau:3a4 Tcaron:164 Tcedil:162 Tcy:422 Tfr:1d517",
    "Therefore:2234 Theta:398 ThickSpace:205f:200a ThinSpace:2009 Tilde:223c TildeEqual:2243 TildeFullEqual:2245 TildeTilde:2248 Topf:1d54b TripleDot:20db Tscr:1d4af Tstrok:166",
    "Uacute:da Uarr:219f Uarrocir:2949 Ubrcy:40e Ubreve:16c Ucirc:db Ucy:423 Udblac:170 Ufr:1d518 Ugrave:d9 Umacr:16a UnderBar:5f",
    "UnderBrace:23df UnderBracket:23b5 UnderParenthesis:23dd Union:22c3 UnionPlus:228e Uogon:172 Uopf:1d54c UpArrow:2191 UpArrowBar:2912 UpArrowDownArrow:21c5 UpDownArrow:2195 UpEquilibrium:296e",
    "UpTee:22a5 UpTeeArrow:21a5 Uparrow:21d1 Updownarrow:21d5 UpperLeftArrow:2196 UpperRightArrow:2197 Upsi:3d2 Upsilon:3a5 Uring:16e Uscr:1d4b0 Utilde:168 Uuml:dc",
    "VDash:22ab Vbar:2aeb Vcy:412 Vdash:22a9 Vdashl:2ae6 Vee:22c1 Verbar:2016 Vert:2016 VerticalBar:2223 VerticalLine:7c VerticalSeparator:2758 VerticalTilde:2240",
    "VeryThinSpace:200a Vfr:1d519 Vopf:1d54d Vscr:1d4b1 Vvdash:22aa Wcirc:174 Wedge:22c0 Wfr:1d51a Wopf:1d54e Wscr:1d4b2 Xfr:1d51b Xi:39e",
    "Xopf:1d54f Xscr:1d4b3 YAcy:42f YIcy:407 YUcy:42e Yacute:dd Ycirc:176 Ycy:42b Yfr:1d51c Yopf:1d550 Yscr:1d4b4 Yuml:178",
    "ZHcy:416 Zacute:179 Zcaron:17d Zcy:417 Zdot:17b ZeroWidthSpace:200b Zeta:396 Zfr:2128 Zopf:2124 Zscr:1d4b5 aacute:e1 abreve:103",
    "ac:223e acE:223e:333 acd:223f acirc:e2 acute:b4 acy:430 aelig:e6 af:2061 afr:1d51e agrave:e0 alefsym:2135 aleph:2135",
    "alpha:3b1 amacr:101 amalg:2a3f amp:26 and:2227 andand:2a55 andd:2a5c andslope:2a58 andv:2a5a ang:2220 ange:29a4 angle:2220",
    "angmsd:2221 angmsdaa:29a8 angmsdab:29a9 angmsdac:29aa angmsdad:29ab angmsdae:29ac angmsdaf:29ad angmsdag:29ae angmsdah:29af angrt:221f angrtvb:22be angrtvbd:299d",
    "angsph:2222 angst:c5 angzarr:237c aogon:105 aopf:1d552 ap:2248 apE:2a70 apacir:2a6f ape:224a apid:224b apos:27 approx:2248",
    "approxeq:224a aring:e5 ascr:1d4b6 ast:2a asymp:2248 asympeq:224d atilde:e3 auml:e4 awconint:2233 awint:2a11 bNot:2aed backcong:224c",
    "backepsilon:3f6 backprime:2035 backsim:223d backsimeq:22cd barvee:22bd barwed:2305 barwedge:2305 bbrk:23b5 bbrktbrk:23b6 bcong:224c bcy:431 bdquo:201e",
    "becaus:2235 because:2235 bemptyv:29b0 bepsi:3f6 bernou:212c beta:3b2 beth:2136 between:226c bfr:1d51f bigcap:22c2 bigcirc:25ef bigcup:22c3",
    "bigodot:2a00 bigoplus:2a01 bigotimes:2a02 bigsqcup:2a06 bigstar:2605 bigtriangledown:25bd bigtriangleup:25b3 biguplus:2a04 bigvee:22c1 bigwedge:22c0 bkarow:290d blacklozenge:29eb",
    "blacksquare:25aa blacktriangle:25b4 blacktriangledown:25be blacktriangleleft:25c2 blacktriangleright:25b8 blank:2423 blk12:2592 blk14:2591 blk34:2593 block:2588 bne:3d:20e5 bnequiv:2261:20e5",
    "bnot:2310 bopf:1d553 bot:22a5 bottom:22a5 bowtie:22c8 boxDL:2557 boxDR:2554 boxDl:2556 boxDr:2553 boxH:2550 boxHD:2566 boxHU:2569",
    "boxHd:2564 boxHu:2567 boxUL:255d boxUR:255a boxUl:255c boxUr:2559 boxV:2551 boxVH:256c boxVL:2563 boxVR:2560 boxVh:256b boxVl:2562",
    "boxVr:255f boxbox:29c9 boxdL:2555 boxdR:2552 boxdl:2510 boxdr:250c boxh:2500 boxhD:2565 boxhU:2568 boxhd:252c boxhu:2534 boxminus:229f",
    "boxplus:229e boxtimes:22a0 boxuL:255b boxuR:2558 boxul:2518 boxur:2514 boxv:2502 boxvH:256a boxvL:2561 boxvR:255e boxvh:253c boxvl:2524",
    "boxvr:251c bprime:2035 breve:2d8 brvbar:a6 bscr:1d4b7 bsemi:204f bsim:223d bsime:22cd bsol:5c bsolb:29c5 bsolhsub:27c8 bull:2022",
    "bullet:2022 bump:224e bumpE:2aae bumpe:224f bumpeq:224f cacute:107 cap:2229 capand:2a44 capbrcup:2a49 capcap:2a4b capcup:2a47 capdot:2a40",
    "caps:2229:fe00 caret:2041 caron:2c7 ccaps:2a4d ccaron:10d ccedil:e7 ccirc:109 ccups:2a4c ccupssm:2a50 cdot:10b cedil:b8 cemptyv:29b2",
    "cent:a2 centerdot:b7 cfr:1d520 chcy:447 check:2713 checkmark:2713 chi:3c7 cir:25cb cirE:29c3 circ:2c6 circeq:2257 circlearrowleft:21ba",
    "circlearrowright:21bb circledR:ae circledS:24c8 circledast:229b circledcirc:229a circleddash:229d cire:2257 cirfnint:2a10 cirmid:2aef cirscir:29c2 clubs:2663 clubsuit:2663",
    "colon:3a colone:2254 coloneq:2254 comma:2c commat:40 comp:2201 compfn:2218 complement:2201 complexes:2102 cong:2245 congdot:2a6d conint:222e",
    "copf:1d554 coprod:2210 copy:a9 copysr:2117 crarr:21b5 cross:2717 cscr:1d4b8 csub:2acf csube:2ad1 csup:2ad0 csupe:2ad2 ctdot:22ef",
    "cudarrl:2938 cudarrr:2935 cuepr:22de cuesc:22df cularr:21b6 cularrp:293d cup:222a cupbrcap:2a48 cupcap:2a46 cupcup:2a4a cupdot:228d cupor:2a45",
    "cups:222a:fe00 curarr:21b7 curarrm:293c curlyeqprec:22de curlyeqsucc:22df curlyvee:22ce curlywedge:22cf curren:a4 curvearrowleft:21b6 curvearrowright:21b7 cuvee:22ce cuwed:22cf",
    "cwconint:2232 cwint:2231 cylcty:232d dArr:21d3 dHar:2965 dagger:2020 daleth:2138 darr:2193 dash:2010 dashv:22a3 dbkarow:290f dblac:2dd",
    "dcaron:10f dcy:434 dd:2146 ddagger:2021 ddarr:21ca ddotseq:2a77 deg:b0 delta:3b4 demptyv:29b1 dfisht:297f dfr:1d521 dharl:21c3",
    "dharr:21c2 diam:22c4 diamond:22c4 diamondsuit:2666 diams:2666 die:a8 digamma:3dd disin:22f2 div:f7 divide:f7 divideontimes:22c7 divonx:22c7",
    "djcy:452 dlcorn:231e dlcrop:230d dollar:24 dopf:1d555 dot:2d9 doteq:2250 doteqdot:2251 dotminus:2238 dotplus:2214 dotsquare:22a1 doublebarwedge:2306",
    "downarrow:2193 downdownarrows:21ca downharpoonleft:21c3 downharpoonright:21c2 drbkarow:2910 drcorn:231f drcrop:230c dscr:1d4b9 dscy:455 dsol:29f6 dstrok:111 dtdot:22f1",
    "dtri:25bf dtrif:25be duarr:21f5 duhar:296f dwangle:29a6 dzcy:45f dzigrarr:27ff eDDot:2a77 eDot:2251 eacute:e9 easter:2a6e ecaron:11b",
    "ecir:2256 ecirc:ea ecolon:2255 ecy:44d edot:117 ee:2147 efDot:2252 efr:1d522 eg:2a9a egrave:e8 egs:2a96 egsdot:2a98",
    "el:2a99 elinters:23e7 ell:2113 els:2a95 elsdot:2a97 emacr:113 empty:2205 emptyset:2205 emptyv:2205 emsp13:2004 emsp14:2005 emsp:2003",
    "eng:14b ensp:2002 eogon:119 eopf:1d556 epar:22d5 eparsl:29e3 eplus:2a71 epsi:3b5 epsilon:3b5 epsiv:3f5 eqcirc:2256 eqcolon:2255",
    "eqsim:2242 eqslantgtr:2a96 eqslantless:2a95 equals:3d equest:225f equiv:2261 equivDD:2a78 eqvparsl:29e5 erDot:2253 erarr:2971 escr:212f esdot:2250",
    "esim:2242 eta:3b7 eth:f0 euml:eb euro:20ac excl:21 exist:2203 expectation:2130 exponentiale:2147 fallingdotseq:2252 fcy:444 female:2640",
    "ffilig:fb03 fflig:fb00 ffllig:fb04 ffr:1d523 filig:fb01 fjlig:66:6a flat:266d fllig:fb02 fltns:25b1 fnof:192 fopf:1d557 forall:2200",
    "fork:22d4 forkv:2ad9 fpartint:2a0d frac12:bd frac13:2153 frac14:bc frac15:2155 frac16:2159 frac18:215b frac23:2154 frac25:2156 frac34:be",
    "frac35:2157 frac38:215c frac45:2158 frac56:215a frac58:215d frac78:215e frasl:2044 frown:2322 fscr:1d4bb gE:2267 gEl:2a8c gacute:1f5",
    "gamma:3b3 gammad:3dd gap:2a86 gbreve:11f gcirc:11d gcy:433 gdot:121 ge:2265 gel:22db geq:2265 geqq:2267 geqslant:2a7e",
    "ges:2a7e gescc:2aa9 gesdot:2a80 gesdoto:2a82 gesdotol:2a84 gesl:22db:fe00 gesles:2a94 gfr:1d524 gg:226b ggg:22d9 gimel:2137 gjcy:453",
    "gl:2277 glE:2a92 gla:2aa5 glj:2aa4 gnE:2269 gnap:2a8a gnapprox:2a8a gne:2a88 gneq:2a88 gneqq:2269 gnsim:22e7 gopf:1d558",
    "grave:60 gscr:210a gsim:2273 gsime:2a8e gsiml:2a90 gt:3e gtcc:2aa7 gtcir:2a7a gtdot:22d7 gtlPar:2995 gtquest:2a7c gtrapprox:2a86",
    "gtrarr:2978 gtrdot:22d7 gtreqless:22db gtreqqless:2a8c gtrless:2277 gtrsim:2273 gvertneqq:2269:fe00 gvnE:2269:fe00 hArr:21d4 hairsp:200a half:bd hamilt:210b",
    "hardcy:44a harr:2194 harrcir:2948 harrw:21ad hbar:210f hcirc:125 hearts:2665 heartsuit:2665 hellip:2026 hercon:22b9 hfr:1d525 hksearow:2925",
    "hkswarow:2926 hoarr:21ff homtht:223b hookleftarrow:21a9 hookrightarrow:21aa hopf:1d559 horbar:2015 hscr:1d4bd hslash:210f hstrok:127 hybull:2043 hyphen:2010",
    "iacute:ed ic:2063 icirc:ee icy:438 iecy:435 iexcl:a1 iff:21d4 ifr:1d526 igrave:ec ii:2148 iiiint:2a0c iiint:222d",
    "iinfin:29dc iiota:2129 ijlig:133 imacr:12b image:2111 imagline:2110 imagpart:2111 imath:131 imof:22b7 imped:1b5 in:2208 incare:2105",
    "infin:221e infintie:29dd inodot:131 int:222b intcal:22ba integers:2124 intercal:22ba intlarhk:2a17 intprod:2a3c iocy:451 iogon:12f iopf:1d55a",
    "iota:3b9 iprod:2a3c iquest:bf iscr:1d4be isin:2208 isinE:22f9 isindot:22f5 isins:22f4 isinsv:22f3 isinv:2208 it:2062 itilde:129",
    "iukcy:456 iuml:ef jcirc:135 jcy:439 jfr:1d527 jmath:237 jopf:1d55b jscr:1d4bf jsercy:458 jukcy:454 kappa:3ba kappav:3f0",
    "kcedil:137 kcy:43a kfr:1d528 kgreen:138 khcy:445 kjcy:45c kopf:1d55c kscr:1d4c0 lAarr:21da lArr:21d0 lAtail:291b lBarr:290e",
    "lE:2266 lEg:2a8b lHar:2962 lacute:13a laemptyv:29b4 lagran:2112 lambda:3bb lang:27e8 langd:2991 langle:27e8 lap:2a85 laquo:ab",
    "larr:2190 larrb:21e4 larrbfs:291f larrfs:291d larrhk:21a9 larrlp:21ab larrpl:2939 larrsim:2973 larrtl:21a2 lat:2aab latail:2919 late:2aad",
    "lates:2aad:fe00 lbarr:290c lbbrk:2772 lbrace:7b lbrack:5b lbrke:298b lbrksld:298f lbrkslu:298d lcaron:13e lcedil:13c lceil:2308 lcub:7b",
    "lcy:43b ldca:2936 ldquo:201c ldquor:201e ldrdhar:2967 ldrushar:294b ldsh:21b2 le:2264 leftarrow:2190 leftarrowtail:21a2 leftharpoondown:21bd leftharpoonup:21bc",
    "leftleftarrows:21c7 leftrightarrow:2194 leftrightarrows:21c6 leftrightharpoons:21cb leftrightsquigarrow:21ad leftthreetimes:22cb leg:22da leq:2264 leqq:2266 leqslant:2a7d les:2a7d lescc:2aa8",
    "lesdot:2a7f lesdoto:2a81 lesdotor:2a83 lesg:22da:fe00 lesges:2a93 lessapprox:2a85 lessdot:22d6 lesseqgtr:22da lesseqqgtr:2a8b lessgtr:2276 lesssim:2272 lfisht:297c",
    "lfloor:230a lfr:1d529 lg:2276 lgE:2a91 lhard:21bd lharu:21bc lharul:296a lhblk:2584 ljcy:459 ll:226a llarr:21c7 llcorner:231e",
    "llhard:296b lltri:25fa lmidot:140 lmoust:23b0 lmoustache:23b0 lnE:2268 lnap:2a89 lnapprox:2a89 lne:2a87 lneq:2a87 lneqq:2268 lnsim:22e6",
    "loang:27ec loarr:21fd lobrk:27e6 longleftarrow:27f5 longleftrightarrow:27f7 longmapsto:27fc longrightarrow:27f6 looparrowleft:21ab looparrowright:21ac lopar:2985 lopf:1d55d loplus:2a2d",
    "lotimes:2a34 lowast:2217 lowbar:5f loz:25ca lozenge:25ca lozf:29eb lpar:28 lparlt:2993 lrarr:21c6 lrcorner:231f lrhar:21cb lrhard:296d",
    "lrm:200e lrtri:22bf lsaquo:2039 lscr:1d4c1 lsh:21b0 lsim:2272 lsime:2a8d lsimg:2a8f lsqb:5b lsquo:2018 lsquor:201a lstrok:142",
    "lt:3c ltcc:2aa6 ltcir:2a79 ltdot:22d6 lthree:22cb ltimes:22c9 ltlarr:2976 ltquest:2a7b ltrPar:2996 ltri:25c3 ltrie:22b4 ltrif:25c2",
    "lurdshar:294a luruhar:2966 lvertneqq:2268:fe00 lvnE:2268:fe00 mDDot:223a macr:af male:2642 malt:2720 maltese:2720 map:21a6 mapsto:21a6 mapstodown:21a7",
    "mapstoleft:21a4 mapstoup:21a5 marker:25ae mcomma:2a29 mcy:43c mdash:2014 measuredangle:2221 mfr:1d52a mho:2127 micro:b5 mid:2223 midast:2a",
    "midcir:2af0 middot:b7 minus:2212 minusb:229f minusd:2238 minusdu:2a2a mlcp:2adb mldr:2026 mnplus:2213 models:22a7 mopf:1d55e mp:2213",
    "mscr:1d4c2 mstpos:223e mu:3bc multimap:22b8 mumap:22b8 nGg:22d9:338 nGt:226b:20d2 nGtv:226b:338 nLeftarrow:21cd nLeftrightarrow:21ce nLl:22d8:338 nLt:226a:20d2",
    "nLtv:226a:338 nRightarrow:21cf nVDash:22af nVdash:22ae nabla:2207 nacute:144 nang:2220:20d2 nap:2249 napE:2a70:338 napid:224b:338 napos:149 napprox:2249",
    "natur:266e natural:266e naturals:2115 nbsp:a0 nbump:224e:338 nbumpe:224f:338 ncap:2a43 ncaron:148 ncedil:146 ncong:2247 ncongdot:2a6d:338 ncup:2a42",
    "ncy:43d ndash:2013 ne:2260 neArr:21d7 nearhk:2924 nearr:2197 nearrow:2197 nedot:2250:338 nequiv:2262 nesear:2928 nesim:2242:338 nexist:2204",
    "nexists:2204 nfr:1d52b ngE:2267:338 nge:2271 ngeq:2271 ngeqq:2267:338 ngeqslant:2a7e:338 nges:2a7e:338 ngsim:2275 ngt:226f ngtr:226f nhArr:21ce",
    "nharr:21ae nhpar:2af2 ni:220b nis:22fc nisd:22fa niv:220b njcy:45a nlArr:21cd nlE:2266:338 nlarr:219a nldr:2025 nle:2270",
    "nleftarrow:219a nleftrightarrow:21ae nleq:2270 nleqq:2266:338 nleqslant:2a7d:338 nles:2a7d:338 nless:226e nlsim:2274 nlt:226e nltri:22ea nltrie:22ec nmid:2224",
    "nopf:1d55f not:ac notin:2209 notinE:22f9:338 notindot:22f5:338 notinva:2209 notinvb:22f7 notinvc:22f6 notni:220c notniva:220c notnivb:22fe notnivc:22fd",
    "npar:2226 nparallel:2226 nparsl:2afd:20e5 npart:2202:338 npolint:2a14 npr:2280 nprcue:22e0 npre:2aaf:338 nprec:2280 npreceq:2aaf:338 nrArr:21cf nrarr:219b",
    "nrarrc:2933:338 nrarrw:219d:338 nrightarrow:219b nrtri:22eb nrtrie:22ed nsc:2281 nsccue:22e1 nsce:2ab0:338 nscr:1d4c3 nshortmid:2224 nshortparallel:2226 nsim:2241",
    "nsime:2244 nsimeq:2244 nsmid:2224 nspar:2226 nsqsube:22e2 nsqsupe:22e3 nsub:2284 nsubE:2ac5:338 nsube:2288 nsubset:2282:20d2 nsubseteq:2288 nsubseteqq:2ac5:338",
    "nsucc:2281 nsucceq:2ab0:338 nsup:2285 nsupE:2ac6:338 nsupe:2289 nsupset:2283:20d2 nsupseteq:2289 nsupseteqq:2ac6:338 ntgl:2279 ntilde:f1 ntlg:2278 ntriangleleft:22ea",
    "ntrianglelefteq:22ec ntriangleright:22eb ntrianglerighteq:22ed nu:3bd num:23 numero:2116 numsp:2007 nvDash:22ad nvHarr:2904 nvap:224d:20d2 nvdash:22ac nvge:2265:20d2",
    "nvgt:3e:20d2 nvinfin:29de nvlArr:2902 nvle:2264:20d2 nvlt:3c:20d2 nvltrie:22b4:20d2 nvrArr:2903 nvrtrie:22b5:20d2 nvsim:223c:20d2 nwArr:21d6 nwarhk:2923 nwarr:2196",
    "nwarrow:2196 nwnear:2927 oS:24c8 oacute:f3 oast:229b ocir:229a ocirc:f4 ocy:43e odash:229d odblac:151 odiv:2a38 odot:2299",
    "odsold:29bc oelig:153 ofcir:29bf ofr:1d52c ogon:2db ograve:f2 ogt:29c1 ohbar:29b5 ohm:3a9 oint:222e olarr:21ba olcir:29be",
    "olcross:29bb oline:203e olt:29c0 omacr:14d omega:3c9 omicron:3bf omid:29b6 ominus:2296 oopf:1d560 opar:29b7 operp:29b9 oplus:2295",
    "or:2228 orarr:21bb ord:2a5d order:2134 orderof:2134 ordf:aa ordm:ba origof:22b6 oror:2a56 orslope:2a57 orv:2a5b oscr:2134",
    "oslash:f8 osol:2298 otilde:f5 otimes:2297 otimesas:2a36 ouml:f6 ovbar:233d par:2225 para:b6 parallel:2225 parsim:2af3 parsl:2afd",
    "part:2202 pcy:43f percnt:25 period:2e permil:2030 perp:22a5 pertenk:2031 pfr:1d52d phi:3c6 phiv:3d5 phmmat:2133 phone:260e",
    "pi:3c0 pitchfork:22d4 piv:3d6 planck:210f planckh:210e plankv:210f plus:2b plusacir:2a23 plusb:229e pluscir:2a22 plusdo:2214 plusdu:2a25",
    "pluse:2a72 plusmn:b1 plussim:2a26 plustwo:2a27 pm:b1 pointint:2a15 popf:1d561 pound:a3 pr:227a prE:2ab3 prap:2ab7 prcue:227c",
    "pre:2aaf prec:227a precapprox:2ab7 preccurlyeq:227c preceq:2aaf precnapprox:2ab9 precneqq:2ab5 precnsim:22e8 precsim:227e prime:2032 primes:2119 prnE:2ab5",
    "prnap:2ab9 prnsim:22e8 prod:220f profalar:232e profline:2312 profsurf:2313 prop:221d propto:221d prsim:227e prurel:22b0 pscr:1d4c5 psi:3c8",
    "puncsp:2008 qfr:1d52e qint:2a0c qopf:1d562 qprime:2057 qscr:1d4c6 quaternions:210d quatint:2a16 quest:3f questeq:225f quot:22 rAarr:21db",
    "rArr:21d2 rAtail:291c rBarr:290f rHar:2964 race:223d:331 racute:155 radic:221a raemptyv:29b3 rang:27e9 rangd:2992 range:29a5 rangle:27e9",
    "raquo:bb rarr:2192 rarrap:2975 rarrb:21e5 rarrbfs:2920 rarrc:2933 rarrfs:291e rarrhk:21aa rarrlp:21ac rarrpl:2945 rarrsim:2974 rarrtl:21a3",
    "rarrw:219d ratail:291a ratio:2236 rationals:211a rbarr:290d rbbrk:2773 rbrace:7d rbrack:5d rbrke:298c rbrksld:298e rbrkslu:2990 rcaron:159",
    "rcedil:157 rceil:2309 rcub:7d rcy:440 rdca:2937 rdldhar:2969 rdquo:201d rdquor:201d rdsh:21b3 real:211c realine:211b realpart:211c",
    "reals:211d rect:25ad reg:ae rfisht:297d rfloor:230b rfr:1d52f rhard:21c1 rharu:21c0 rharul:296c rho:3c1 rhov:3f1 rightarrow:2192",
    "rightarrowtail:21a3 rightharpoondown:21c1 rightharpoonup:21c0 rightleftarrows:21c4 rightleftharpoons:21cc rightrightarrows:21c9 rightsquigarrow:219d rightthreetimes:22cc ring:2da risingdotseq:2253 rlarr:21c4 rlhar:21cc",
    "rlm:200f rmoust:23b1 rmoustache:23b1 rnmid:2aee roang:27ed roarr:21fe robrk:27e7 ropar:2986 ropf:1d563 roplus:2a2e rotimes:2a35 rpar:29",
    "rpargt:2994 rppolint:2a12 rrarr:21c9 rsaquo:203a rscr:1d4c7 rsh:21b1 rsqb:5d rsquo:2019 rsquor:2019 rthree:22cc rtimes:22ca rtri:25b9",
    "rtrie:22b5 rtrif:25b8 rtriltri:29ce ruluhar:2968 rx:211e sacute:15b sbquo:201a sc:227b scE:2ab4 scap:2ab8 scaron:161 sccue:227d",
    "sce:2ab0 scedil:15f scirc:15d scnE:2ab6 scnap:2aba scnsim:22e9 scpolint:2a13 scsim:227f scy:441 sdot:22c5 sdotb:22a1 sdote:2a66",
    "seArr:21d8 searhk:2925 searr:2198 searrow:2198 sect:a7 semi:3b seswar:2929 setminus:2216 setmn:2216 sext:2736 sfr:1d530 sfrown:2322",
    "sharp:266f shchcy:449 shcy:448 shortmid:2223 shortparallel:2225 shy:ad sigma:3c3 sigmaf:3c2 sigmav:3c2 sim:223c simdot:2a6a sime:2243",
    "simeq:2243 simg:2a9e simgE:2aa0 siml:2a9d simlE:2a9f simne:2246 simplus:2a24 simrarr:2972 slarr:2190 smallsetminus:2216 smashp:2a33 smeparsl:29e4",
    "smid:2223 smile:2323 smt:2aaa smte:2aac smtes:2aac:fe00 softcy:44c sol:2f solb:29c4 solbar:233f sopf:1d564 spades:2660 spadesuit:2660",
    "spar:2225 sqcap:2293 sqcaps:2293:fe00 sqcup:2294 sqcups:2294:fe00 sqsub:228f sqsube:2291 sqsubset:228f sqsubseteq:2291 sqsup:2290 sqsupe:2292 sqsupset:2290",
    "sqsupseteq:2292 squ:25a1 square:25a1 squarf:25aa squf:25aa srarr:2192 sscr:1d4c8 ssetmn:2216 ssmile:2323 sstarf:22c6 star:2606 starf:2605",
    "straightepsilon:3f5 straightphi:3d5 strns:af sub:2282 subE:2ac5 subdot:2abd sube:2286 subedot:2ac3 submult:2ac1 subnE:2acb subne:228a subplus:2abf",
    "subrarr:2979 subset:2282 subseteq:2286 subseteqq:2ac5 subsetneq:228a subsetneqq:2acb subsim:2ac7 subsub:2ad5 subsup:2ad3 succ:227b succapprox:2ab8 succcurlyeq:227d",
    "succeq:2ab0 succnapprox:2aba succneqq:2ab6 succnsim:22e9 succsim:227f sum:2211 sung:266a sup1:b9 sup2:b2 sup3:b3 sup:2283 supE:2ac6",
    "supdot:2abe supdsub:2ad8 supe:2287 supedot:2ac4 suphsol:27c9 suphsub:2ad7 suplarr:297b supmult:2ac2 supnE:2acc supne:228b supplus:2ac0 supset:2283",
    "supseteq:2287 supseteqq:2ac6 supsetneq:228b supsetneqq:2acc supsim:2ac8 supsub:2ad4 supsup:2ad6 swArr:21d9 swarhk:2926 swarr:2199 swarrow:2199 swnwar:292a",
    "szlig:df target:2316 tau:3c4 tbrk:23b4 tcaron:165 tcedil:163 tcy:442 tdot:20db telrec:2315 tfr:1d531 there4:2234 therefore:2234",
    "theta:3b8 thetasym:3d1 thetav:3d1 thickapprox:2248 thicksim:223c thinsp:2009 thkap:2248 thksim:223c thorn:fe tilde:2dc times:d7 timesb:22a0",
    "timesbar:2a31 timesd:2a30 tint:222d toea:2928 top:22a4 topbot:2336 topcir:2af1 topf:1d565 topfork:2ada tosa:2929 tprime:2034 trade:2122",
    "triangle:25b5 triangledown:25bf triangleleft:25c3 trianglelefteq:22b4 triangleq:225c triangleright:25b9 trianglerighteq:22b5 tridot:25ec trie:225c triminus:2a3a triplus:2a39 trisb:29cd",
    "tritime:2a3b trpezium:23e2 tscr:1d4c9 tscy:446 tshcy:45b tstrok:167 twixt:226c twoheadleftarrow:219e twoheadrightarrow:21a0 uArr:21d1 uHar:2963 uacute:fa",
    "uarr:2191 ubrcy:45e ubreve:16d ucirc:fb ucy:443 udarr:21c5 udblac:171 udhar:296e ufisht:297e ufr:1d532 ugrave:f9 uharl:21bf",
    "uharr:21be uhblk:2580 ulcorn:231c ulcorner:231c ulcrop:230f ultri:25f8 umacr:16b uml:a8 uogon:173 uopf:1d566 uparrow:2191 updownarrow:2195",
    "upharpoonleft:21bf upharpoonright:21be uplus:228e upsi:3c5 upsih:3d2 upsilon:3c5 upuparrows:21c8 urcorn:231d urcorner:231d urcrop:230e uring:16f urtri:25f9",
    "uscr:1d4ca utdot:22f0 utilde:169 utri:25b5 utrif:25b4 uuarr:21c8 uuml:fc uwangle:29a7 vArr:21d5 vBar:2ae8 vBarv:2ae9 vDash:22a8",
    "vangrt:299c varepsilon:3f5 varkappa:3f0 varnothing:2205 varphi:3d5 varpi:3d6 varpropto:221d varr:2195 varrho:3f1 varsigma:3c2 varsubsetneq:228a:fe00 varsubsetneqq:2acb:fe00",
    "varsupsetneq:228b:fe00 varsupsetneqq:2acc:fe00 vartheta:3d1 vartriangleleft:22b2 vartriangleright:22b3 vcy:432 vdash:22a2 vee:2228 veebar:22bb veeeq:225a vellip:22ee verbar:7c",
    "vert:7c vfr:1d533 vltri:22b2 vnsub:2282:20d2 vnsup:2283:20d2 vopf:1d567 vprop:221d vrtri:22b3 vscr:1d4cb vsubnE:2acb:fe00 vsubne:228a:fe00 vsupnE:2acc:fe00",
    "vsupne:228b:fe00 vzigzag:299a wcirc:175 wedbar:2a5f wedge:2227 wedgeq:2259 weierp:2118 wfr:1d534 wopf:1d568 wp:2118 wr:2240 wreath:2240",
    "wscr:1d4cc xcap:22c2 xcirc:25ef xcup:22c3 xdtri:25bd xfr:1d535 xhArr:27fa xharr:27f7 xi:3be xlArr:27f8 xlarr:27f5 xmap:27fc",
    "xnis:22fb xodot:2a00 xopf:1d569 xoplus:2a01 xotime:2a02 xrArr:27f9 xrarr:27f6 xscr:1d4cd xsqcup:2a06 xuplus:2a04 xutri:25b3 xvee:22c1",
    "xwedge:22c0 yacute:fd yacy:44f ycirc:177 ycy:44b yen:a5 yfr:1d536 yicy:457 yopf:1d56a yscr:1d4ce yucy:44e yuml:ff",
    "zacute:17a zcaron:17e zcy:437 zdot:17c zeetrf:2128 zeta:3b6 zfr:1d537 zhcy:436 zigrarr:21dd zopf:1d56b zscr:1d4cf zwj:200d",
    "zwnj:200c",
].join(" ").split(" ").map(entry => {
    const [name, ...points] = entry.split(":");
    return [name, String.fromCodePoint(...points.map(point => Number.parseInt(point, 16)))];
}));

function decodeMarkdownReferences(text) {
    return text.replace(/\\([!-/:-@\[-`{-~])|&(#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (reference, escaped, name) => {
        if (escaped !== undefined) return escaped;
        if (!name.startsWith("#")) return MARKDOWN_NAMED_REFERENCES.get(name) ?? reference;

        const hexadecimal = name[1] === "x" || name[1] === "X";
        const point = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return "\ufffd";
        return String.fromCodePoint(point);
    });
}

const SAFE_HTML_TAGS = new Set([
    "a", "abbr", "article", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol", "p", "picture", "rp", "rt", "ruby", "s", "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr",
]);
const VOID_HTML_TAGS = new Set(["br", "col", "hr", "img", "input", "source", "wbr"]);
const URL_ATTRIBUTES = new Set(["cite", "href", "poster", "src"]);
const SAFE_HTML_ATTRIBUTES = new Set([
    "alt", "aria-describedby", "aria-label", "aria-labelledby", "checked", "class", "colspan", "controls", "disabled", "height", "id", "open", "rel", "rowspan", "scope", "span", "start", "target", "title", "type", "width",
]);

function isSafeUrl(url) {
    const normalized = String(url).trim().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith("#") || normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) return true;
    return /^(?:https?:|mailto:)/.test(normalized) || !/^[a-z][a-z0-9+.-]*:/i.test(normalized);
}

function sanitizeHtmlTag(tag, options = {}) {
    const match = tag.match(/^<\s*(\/?)\s*([a-zA-Z][\w-]*)([\s\S]*?)>$/);
    if (!match) return escapeHtml(tag);
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    const rawAttributes = match[3];
    const isSelfClosing = /\/\s*$/.test(rawAttributes);
    const mediaAllowed = options.allowAudioVideo && (name === "audio" || name === "video");
    if ((!SAFE_HTML_TAGS.has(name) && !mediaAllowed) || (isSelfClosing && !VOID_HTML_TAGS.has(name))) return escapeHtml(tag);
    if (closing) return `</${name}>`;

    let attributes = "";
    const attributePattern = /([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g;
    for (const attributeMatch of rawAttributes.replace(/\/\s*$/, "").matchAll(attributePattern)) {
        const attributeName = attributeMatch[1].toLowerCase();
        if (!SAFE_HTML_ATTRIBUTES.has(attributeName) && !URL_ATTRIBUTES.has(attributeName)) continue;
        const hasValue = attributeMatch[2] !== undefined || attributeMatch[3] !== undefined || attributeMatch[4] !== undefined;
        if (!hasValue) {
            attributes += ` ${attributeName}`;
            continue;
        }
        const value = attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4];
        if (URL_ATTRIBUTES.has(attributeName) && !isSafeUrl(value)) continue;
        attributes += ` ${attributeName}="${escapeHtmlAttribute(value)}"`;
    }
    return `<${name}${attributes}>`;
}

function sanitizeHtmlFragment(html, options = {}) {
    if (options.allowUnsafeHtml) return html;
    return html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, (tag) => tag.startsWith("<!--") ? "" : sanitizeHtmlTag(tag, options));
}

/**
 * Splits a table row by unescaped '|' delimiters, respecting escaped pipes (\|) and pipes inside inline code.
 * @param {string} rowStr
 * @returns {string[]} Cell strings
 */
function splitTableRow(rowStr) {
    let s = rowStr.trim().replace(/\\\|/g, "\uFFFD");
    s = s.replace(/`([^`]+)`/g, (match) => match.replace(/\|/g, "\uFFFD"));

    const rawCells = s.split("|");
    if (rawCells.length > 0 && rawCells[0].trim() === "") rawCells.shift();
    if (rawCells.length > 0 && rawCells[rawCells.length - 1].trim() === "") rawCells.pop();

    return rawCells.map((cell) => cell.replace(/\uFFFD/g, "|"));
}

/**
 * Converts heading text into a URL-safe slug ID.
 * @param {string} text
 * @returns {string} Slug string
 */
function slugify(text) {
    let slug = text.toLowerCase();
    if (slug.includes("{#") && slug.includes("}")) {
        slug = slug.replace(/\{#[^}]+\}/g, "");
    }
    if (slug.includes("`")) {
        const firstBacktick = slug.indexOf("`");
        if (slug.indexOf("`", firstBacktick + 1) !== -1) {
            slug = slug.replace(/`([^`]+)`/g, "$1");
        }
    }
    if (slug.includes("<") && slug.includes(">")) {
        slug = slug.replace(/<[^>]+>/g, "");
    }
    return slug
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}

/**
 * Returns a unique slug string given a heading text, tracking map, and optional prefix.
 * @param {string} rawHeader
 * @param {Object.<string, number>} slugCounts
 * @param {string} [prefix=""]
 * @returns {string} Unique slug
 */
function getUniqueSlug(rawHeader, slugCounts, prefix = "") {
    const explicitMatch = rawHeader.match(/\{#([a-zA-Z0-9_-]+)[^}]*\}/);
    const baseSlug = `${prefix}${explicitMatch ? explicitMatch[1] : (slugify(rawHeader) || "heading")}`;
    let slug = baseSlug;
    let suffix = slugCounts[baseSlug] || 0;
    while (slugCounts[slug] !== undefined) {
        suffix++;
        slug = `${baseSlug}-${suffix}`;
    }
    slugCounts[baseSlug] = suffix;

    // Reserve the emitted ID too, since a later heading may use it as its base slug.
    slugCounts[slug] = 0;

    return slug;
}

/**
 * Extracts structured headings from Markdown text (skipping headings inside fenced code blocks).
 * @param {string} markdown
 * @param {object} [options] - Options object
 * @param {string} [options.slugPrefix=""] - Optional prefix for generated anchor slugs
 * @returns {Array<{ level: number, title: string, slug: string, rawText: string }>} Headings list
 */
function extractHeadings(markdown, options = {}) {
    markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const lines = markdown.split(/\r?\n/);
    const headings = [];
    const slugCounts = Object.create(null);
    const slugPrefix = options.headingIdPrefix || options.slugPrefix || "";
    let inFence = false;
    let fenceChar = null;
    let fenceLen = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                fenceChar = fenceMatch[1][0];
                fenceLen = fenceMatch[1].length;
            } else {
                const endMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (endMatch && endMatch[1][0] === fenceChar && endMatch[1].length >= fenceLen) {
                    inFence = false;
                }
            }
            continue;
        }

        if (inFence) continue;

        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            let rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const explicitMatch = rawHeader.match(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            if (explicitMatch) {
                rawHeader = rawHeader.replace(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/, "").trim();
            }
            const title = parseInline(rawHeader);
            headings.push({ level, title, slug, rawText: rawHeader });
            continue;
        }

        if (i + 1 < lines.length && line.trim() && !line.match(/^\s{0,3}(?:[-*+]|\d+[.)]|>|\|)/)) {
            const nextLine = lines[i + 1].trim();
            if (/^={2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                const title = parseInline(rawHeader);
                headings.push({ level: 1, title, slug, rawText: rawHeader });
                i++;
                continue;
            } else if (/^-{2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                const title = parseInline(rawHeader);
                headings.push({ level: 2, title, slug, rawText: rawHeader });
                i++;
                continue;
            }
        }
    }

    return headings;
}

/**
 * Generates an HTML Table of Contents from Markdown text with full CSS & structure customization.
 * @param {string} markdown
 * @param {object} [options] - Options object
 * @returns {string} HTML TOC string
 */
function generateTOC(markdown, options = {}) {
    const headings = extractHeadings(markdown, options);
    const minLevel = options.minLevel || 1;
    const maxLevel = options.maxLevel || 6;
    const filtered = headings.filter(h => h.level >= minLevel && h.level <= maxLevel);

    if (filtered.length === 0) return "";

    const containerTag = options.containerTag !== undefined ? options.containerTag : "nav";
    const containerClass = options.containerClass !== undefined ? options.containerClass : "toc";
    const titleText = options.title || "";

    const ulAttr = options.ulClass ? ` class="${escapeHtml(options.ulClass)}"` : "";
    const liAttr = options.liClass ? ` class="${escapeHtml(options.liClass)}"` : "";
    const aAttr = options.aClass ? ` class="${escapeHtml(options.aClass)}"` : "";

    let html = "";
    if (containerTag) {
        const classAttr = containerClass ? ` class="${escapeHtml(containerClass)}"` : "";
        html += `<${containerTag}${classAttr}>`;
    }

    if (titleText) {
        html += titleText.startsWith("<") ? titleText : `<h2 class="toc-title">${escapeHtml(titleText)}</h2>`;
    }

    const root = { children: [] };
    const stack = [root];
    filtered.forEach((heading) => {
        while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop();
        const node = { ...heading, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
    });
    const renderNodes = (nodes) => `<ul${ulAttr}>${nodes.map((node) => {
        const children = node.children.length ? renderNodes(node.children) : "";
        return `<li${liAttr}><a href="#${escapeHtmlAttribute(node.slug)}"${aAttr}>${node.title}</a>${children}</li>`;
    }).join("")}</ul>`;
    html += renderNodes(root.children);

    if (containerTag) {
        html += `</${containerTag}>`;
    }

    return html;
}

/**
 * Checks if a line matches a list item marker (and is not a horizontal rule).
 * @param {string} line
 * @param {number} [column=0] - Starting column for a nested marker on the same line
 * @returns {{ indent: number, contentIndent: number, start: number, type: "ul"|"ol", prefix: string, text: string } | null}
 */
function getListItemMatch(line, column = 0) {
    if (!line) return null;
    if (/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line)) {
        return null;
    }
    const match = line.match(/^([ \t]*)([-*+]|\d+[.)])([ \t]+)/);
    if (!match) return null;
    const marker = match[2];
    const isOrdered = /^\d+[.)]/.test(marker);
    const indent = getIndentWidth(match[1], column);
    const contentIndent = getIndentWidth(match[3], indent + marker.length);
    let itemText = line.slice(match[0].length);
    let prefix = "";

    // Task lists: - [ ] or - [x] or - [X]
    const taskMatch = itemText.match(/^\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
        const taskText = taskMatch[2].trim();
        const accessibleName = taskText || "Task item";
        prefix = `<input type="checkbox"${checked} aria-label="${escapeHtmlAttribute(accessibleName)}" disabled> `;
        itemText = taskMatch[2];
    }

    return {
        indent,
        contentIndent,
        start: isOrdered ? Number.parseInt(marker, 10) : 1,
        type: isOrdered ? "ol" : "ul",
        prefix,
        text: itemText,
    };
}

function getIndentWidth(line, column = 0) {
    for (const char of line) {
        if (char === " ") column++;
        else if (char === "\t") column += 4 - column % 4;
        else break;
    }
    return column;
}

function removeIndent(line, width) {
    let column = 0;
    let index = 0;
    while (index < line.length && column < width) {
        if (line[index] === " ") column++;
        else if (line[index] === "\t") column += 4 - column % 4;
        else break;
        index++;
    }
    return " ".repeat(Math.max(0, column - width)) + line.slice(index);
}

function getFenceMatch(line) {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!match || (match[2][0] === "`" && match[3].includes("`"))) return null;
    return { indent: match[1].length, marker: match[2], info: match[3].trim() };
}

function isListBlockBoundary(line) {
    return getFenceMatch(line) ||
        /^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line) ||
        /^\s{0,3}#{1,6}\s+/.test(line) ||
        line.trim().startsWith(">") ||
        line.trim().startsWith("|") ||
        /^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(line.trim());
}

function readFencedCodeBlock(lines, index, containerIndent = 0, openingLine = removeIndent(lines[index], containerIndent)) {
    const fence = getFenceMatch(openingLine);
    if (!fence) return null;

    const codeLines = [];
    let end = index + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && getIndentWidth(line) < containerIndent) break;

        const content = removeIndent(line, containerIndent);
        const closing = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length) {
            end++;
            break;
        }
        codeLines.push(removeIndent(content, fence.indent));
        end++;
    }
    return { end, info: fence.info, code: codeLines.join("\n") };
}

function readIndentedCodeBlock(lines, index, containerIndent = 0) {
    const width = containerIndent + 4;
    if (getIndentWidth(lines[index]) < width) return null;

    const codeLines = [];
    let end = index;
    while (end < lines.length && (!lines[end].trim() || getIndentWidth(lines[end]) >= width)) {
        codeLines.push(removeIndent(lines[end], width));
        end++;
    }
    return { end, info: "", code: codeLines.join("\n").replace(/\n+$/, "") };
}

function renderCodeBlock(block) {
    const attrMatch = block.info.match(/^\{(?:\.([a-zA-Z0-9_-]+))?[^}]*\}$/);
    const language = attrMatch?.[1] || block.info.split(/\s+/)[0] || "";
    const safeLanguage = escapeHtmlAttribute(language.replace(/^\{?\.?([a-zA-Z0-9_-]+).*$/, "$1"));
    const langClass = safeLanguage ? ` class="language-${safeLanguage}"` : "";
    return `<pre><code${langClass}>${escapeHtmlLiteral(block.code)}</code></pre>`;
}

function normalizeCodeSpan(code) {
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && !/^\s+$/.test(code)) {
        return code.slice(1, -1);
    }
    return code;
}

/**
 * Parses inline formatting: `code`, ![img](url), ***bold-italic***, **bold**, *italic*, strikethrough, highlight, sub/sup, links, etc.
 * @param {string} text
 * @param {object} [context={}]
 * @returns {string} HTML string
 */
function parseInline(text, context = {}, restoreParentSource = text => text) {
    if (!text) return "";
    text = String(text);

    const uniquePrefix = `\uFFFC_${Math.random().toString(36).substring(2, 9)}_`;
    const tokens = [];
    const tokenSources = [];
    const tokenPattern = new RegExp(`${uniquePrefix}(\\d+)\uFFFC`, "g");

    // Attributes need the original text before decoding, URL validation and HTML escaping.
    function restoreSource(source) {
        return restoreParentSource(source.replace(tokenPattern, (placeholder, index) => tokenSources[Number(index)] ?? placeholder));
    }

    function decodeAttribute(source) {
        return decodeMarkdownReferences(restoreSource(source));
    }

    function decodeDestination(source) {
        source = restoreSource(source).trim();
        if (source.startsWith("<") && source.endsWith(">")) source = source.slice(1, -1);
        return decodeMarkdownReferences(source);
    }

    function renderImageAlt(source) {
        source = restoreSource(source);
        let html = "";
        let end = 0;

        // Escapes protect literal backticks; only text outside code decodes references.
        for (const match of source.matchAll(/\\[!-/:-@\[-`{-~]|(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|`+/g)) {
            if (!match[1]) continue;
            html += escapeHtmlAttribute(decodeMarkdownReferences(source.slice(end, match.index)));
            html += escapeHtmlAttribute(normalizeCodeSpan(match[2]));
            end = match.index + match[0].length;
        }
        return html + escapeHtmlAttribute(decodeMarkdownReferences(source.slice(end)));
    }

    function addToken(html, source = html) {
        const placeholder = `${uniquePrefix}${tokens.length}\uFFFC`;
        tokens.push(html);
        tokenSources.push(restoreSource(source));
        return placeholder;
    }

    // 1. Process inline code spans (handles single and multi-backticks, padding spaces)
    if (text.includes("`")) {
        text = text.replace(/(`+)([\s\S]*?)\1/g, (match, fence, code) => {
            return addToken(`<code>${escapeHtmlLiteral(normalizeCodeSpan(code))}</code>`, match);
        });
    }

    // 2. Escaped markdown punctuation
    text = text.replace(/\\([!-/:-@\[-`{-~])/g, (match, char) => {
        return addToken(escapeHtmlLiteral(char), match);
    });

    // 3. Safe inline HTML tags
    const safeTagRegex = /<\/?(?:em|strong|b|i|del|ins|mark|sub|sup|small|u|s|kbd|var|ruby|rp|rt|abbr|wbr|br|span|a|picture|source|audio|video|img|input)(?:\s+[^<>]*)?\/?>/gi;
    if (text.includes("<") && text.includes(">")) {
        text = text.replace(safeTagRegex, (match) => {
            return addToken(sanitizeHtmlTag(match, context.options), match);
        });
    }

    // 4. Autolinks: <https://...> or <user@example.com>
    if (text.includes("<") && text.includes(">")) {
        text = text.replace(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]+)>/g, (match, url) => {
            if (!isSafeUrl(url)) return escapeHtml(url);
            const safeUrl = escapeHtmlAttribute(url);
            return addToken(`<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`, match);
        });
        text = text.replace(/<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g, (match, email) => {
            const safeEmail = escapeHtml(email);
            return addToken(`<a href="mailto:${safeEmail}">${safeEmail}</a>`, match);
        });
    }

    if (text.includes("[![")) text = text.replace(/\[!\[([^\]]*)\]\(([^\s)]+)\)\]\(([^\s)]+)\)/g, (match, altText, imageUrl, linkUrl) => {
        imageUrl = decodeDestination(imageUrl);
        linkUrl = decodeDestination(linkUrl);
        if (!isSafeUrl(imageUrl) || !isSafeUrl(linkUrl)) return escapeHtml(altText);
        return addToken(`<a href="${escapeHtmlAttribute(linkUrl)}" target="_blank" rel="noopener"><img src="${escapeHtmlAttribute(imageUrl)}" alt="${renderImageAlt(altText)}"></a>`, match);
    });

    // 5. Wiki-links: [[Target]] or [[Target|Label]]
    if (text.includes("[[") && text.includes("]]")) {
        text = text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (match, target, label) => {
            const displayText = escapeHtml((label || target).trim());
            const slug = slugify(target.trim());
            return addToken(`<a href="#${slug}">${displayText}</a>`, match);
        });
    }

    // 6. Markdown Images
    if (text.includes("![") && text.includes("]")) text = text.replace(/!\[([^\]]*)\](?:\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)|\[([^\]]*)\])?(?:\{([^}]+)\})?/g, (match, altText, url, title1, title2, refKey, attrs) => {
        let finalUrl = url !== undefined ? url : "";
        let finalTitle = title1 || title2 || "";
        if (url === undefined) {
            const key = restoreSource(refKey || altText).toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (!ref) return match;
            finalUrl = ref.url;
            if (!finalTitle && ref.title) finalTitle = ref.title;
        }
        finalUrl = decodeDestination(finalUrl);
        finalTitle = decodeAttribute(finalTitle.trim());
        if (!isSafeUrl(finalUrl)) return addToken(escapeHtml(altText.trim()), match);
        const safeUrl = escapeHtmlAttribute(finalUrl);
        const safeAlt = renderImageAlt(altText.trim());
        const titleAttr = finalTitle ? ` title="${escapeHtmlAttribute(finalTitle)}"` : "";
        let attrStr = "";
        if (attrs) {
            const widthMatch = attrs.match(/width=(\d+)/);
            const heightMatch = attrs.match(/height=(\d+)/);
            if (widthMatch) attrStr += ` width="${widthMatch[1]}"`;
            if (heightMatch) attrStr += ` height="${heightMatch[1]}"`;
        }
        return addToken(`<img src="${safeUrl}" alt="${safeAlt}"${titleAttr}${attrStr}>`, match);
    });

    // 7. Markdown Links: [text](url "title") or [text][ref] or [text][]
    if (text.includes("[") && text.includes("]")) text = text.replace(/\[([^\]]*)\](?:\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)|\[([^\]]*)\])/g, (match, linkText, url, title1, title2, refKey) => {
        let finalUrl = url !== undefined ? url : "";
        let finalTitle = title1 || title2 || "";
        if (refKey !== undefined) {
            const key = (refKey || linkText).toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (ref) {
                finalUrl = ref.url;
                if (!finalTitle && ref.title) finalTitle = ref.title;
            }
        }
        if (!finalUrl && refKey === undefined && url === undefined) {
            const key = linkText.toLowerCase().trim();
            const ref = context.references && context.references[key];
            if (ref) {
                finalUrl = ref.url;
                if (!finalTitle && ref.title) finalTitle = ref.title;
            }
        }
        const formattedText = parseInline(linkText, context, restoreSource);
        finalUrl = decodeDestination(finalUrl);
        finalTitle = decodeAttribute(finalTitle.trim());
        if (!isSafeUrl(finalUrl)) return addToken(formattedText, match);
        const safeUrl = escapeHtmlAttribute(finalUrl);
        const titleAttr = finalTitle ? ` title="${escapeHtmlAttribute(finalTitle)}"` : "";
        return addToken(`<a href="${safeUrl}"${titleAttr} target="_blank" rel="noopener">${formattedText}</a>`, match);
    });

    if (text.includes("[") && text.includes("]")) text = text.replace(/\[([^\]^]+)\]/g, (match, linkText) => {
        const ref = context.references && context.references[linkText.toLowerCase().trim()];
        if (!ref) return match;
        const url = decodeDestination(ref.url);
        if (!isSafeUrl(url)) return match;
        const titleAttr = ref.title ? ` title="${escapeHtmlAttribute(decodeAttribute(ref.title.trim()))}"` : "";
        return addToken(`<a href="${escapeHtmlAttribute(url)}"${titleAttr} target="_blank" rel="noopener">${parseInline(linkText, context, restoreSource)}</a>`, match);
    });

    // 8. Footnote references: [^id]
    if (text.includes("[^") && text.includes("]")) text = text.replace(/\[\^([^\]]+)\]/g, (_, id) => {
        const safeId = escapeHtmlAttribute(id);
        if (context.footnoteOrder && !context.footnoteOrder.includes(id)) {
            context.footnoteOrder.push(id);
        }
        const num = context.footnoteOrder ? context.footnoteOrder.indexOf(id) + 1 : 1;
        context.footnoteReferenceCounts ||= Object.create(null);
        context.footnoteReferenceCounts[id] = (context.footnoteReferenceCounts[id] || 0) + 1;
        const suffix = context.footnoteReferenceCounts[id] > 1 ? `-${context.footnoteReferenceCounts[id]}` : "";
        return addToken(`<sup><a href="#fn-${safeId}" id="fnref-${safeId}${suffix}">[${num}]</a></sup>`);
    });

    // 9. Escape raw HTML characters
    text = escapeHtml(text);

    // 10. Bare URLs (GFM autolink)
    text = text.replace(/(^|\s)(https?:\/\/[^\s<>()]+)(?=\s|$|[.,!?:;])/g, (_, before, url) => {
        const safeUrl = escapeHtml(url);
        return `${before}${addToken(`<a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>`)}`;
    });

    // 11. Inline formatting
    text = text.replace(/~~(.*?)~~/g, "<del>$1</del>");
    text = text.replace(/==(.*?)==/g, "<mark>$1</mark>");
    text = text.replace(/\+\+(.*?)\+\+/g, "<ins>$1</ins>");
    text = text.replace(/~([^\s~]+)~/g, "<sub>$1</sub>");
    text = text.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
    text = text.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/___(.*?)___/g, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\b__(.*?)__\b/g, "<strong>$1</strong>");
    text = text.replace(/(^|\s)_([^\s_<>]|[^\s_<>][^_<>]*?[^\s_<>])_(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");
    text = text.replace(/<strong>[\s\S]*?<\/strong>/g, (match) => addToken(match));
    text = text.replace(/(^|\s)\*([^\s*<>]|[^\s*<>][^*<>]*?[^\s*<>])\*(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");
    text = text.replace(/(^|\s)_([^\s_<>]|[^\s_<>][^_<>]*?[^\s_<>])_(?=\s|$|[.,!?:;()\[\]]|<)/g, "$1<em>$2</em>");

    if (tokens.length > 0) {
        const restoreToken = (placeholder, index) => tokens[Number(index)] ?? placeholder;

        // Later tokens can contain placeholders for earlier tokens.
        for (let index = 0; index < tokens.length; index++) {
            if (tokens[index].includes(uniquePrefix)) {
                tokens[index] = tokens[index].replace(tokenPattern, restoreToken);
            }
        }
        text = text.replace(tokenPattern, restoreToken);
    }

    return text;
}

/**
 * Converts a Markdown string into formatted HTML with optional class and feature customizations.
 * @param {string} markdown
 * @param {object} [options] - Configuration options
 * @param {object|boolean} [options.toc] - Options for TOC generation, or `false` to disable inline [TOC]
 * @param {boolean} [options.toc.injectIfAbsent=false] - Prepend a TOC when no document-level TOC marker is rendered; adds nothing without eligible headings
 * @param {string} [options.headingIdPrefix=""] - Prefix prepended to heading anchor IDs
 * @param {string} [options.headingClass=""] - Custom CSS class added to <h1..h6> elements
 * @param {string} [options.tableContainerClass="table-container"] - CSS class for table wrapper <div>
 * @param {string} [options.noteClass="note"] - CSS class for blockquote wrapper <div>
 * @returns {string} HTML string
 */
function parseMarkdownToHTML(markdown, options = {}) {
    if (typeof markdown !== "string") {
        throw new TypeError("markdown must be a string");
    }
    if (!markdown || !markdown.trim()) return "";

    // 1. Strip YAML frontmatter at top of document
    markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

    const lines = markdown.split(/\r?\n/);
    const output = [];
    const slugCounts = Object.create(null);
    const slugPrefix = options.headingIdPrefix || options.slugPrefix || "";
    const tableContainerClass = options.tableContainerClass !== undefined ? options.tableContainerClass : "table-container";
    const noteClass = options.noteClass !== undefined ? options.noteClass : "note";
    const headingClass = options.headingClass ? ` class="${escapeHtmlAttribute(options.headingClass)}"` : "";
    const nestedOptions = options.toc?.injectIfAbsent
        ? { ...options, toc: { ...options.toc, injectIfAbsent: false } }
        : options;
    let hasToc = false;

    const context = {
        references: Object.create(null),
        footnotes: Object.create(null),
        footnoteOrder: [],
        footnoteReferenceCounts: Object.create(null),
        options,
    };

    // 2. First pass: Collect reference link definitions and footnote definitions
    const cleanedLines = [];
    const definitionListStack = [];
    for (let r = 0; r < lines.length; r++) {
        const l = lines[r];
        let item = getListItemMatch(l);
        if (item) {
            while (definitionListStack.length && definitionListStack[definitionListStack.length - 1].indent >= item.indent) {
                definitionListStack.pop();
            }
            definitionListStack.push(item);

            let child = getListItemMatch(item.text, item.contentIndent);
            while (child) {
                definitionListStack.push(child);
                item = child;
                child = getListItemMatch(item.text, item.contentIndent);
            }
        } else if (l.trim()) {
            const indent = getIndentWidth(l);
            while (definitionListStack.length && definitionListStack[definitionListStack.length - 1].contentIndent > indent) {
                definitionListStack.pop();
            }
        }

        const containerIndent = definitionListStack.length ? definitionListStack[definitionListStack.length - 1].contentIndent : 0;
        const block = readFencedCodeBlock(lines, r, containerIndent, item ? item.text : removeIndent(l, containerIndent)) || (!item ? readIndentedCodeBlock(lines, r, containerIndent) : null);
        if (block) {
            while (r < block.end) {
                cleanedLines.push(lines[r]);
                r++;
            }
            r--;
            continue;
        }

        if (isListBlockBoundary(l)) definitionListStack.length = 0;

        const refMatch = l.match(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\s*$/);
        const fnMatch = l.match(/^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/);
        const abbrMatch = l.match(/^\s{0,3}\*\[([^\]]+)\]:\s*(.*)$/);

        if (fnMatch) {
            const fnId = fnMatch[1];
            let fnContent = fnMatch[2];
            let nextR = r + 1;
            while (nextR < lines.length && (lines[nextR].startsWith("    ") || lines[nextR].startsWith("\t") || !lines[nextR].trim())) {
                if (lines[nextR].trim()) {
                    fnContent += "\n" + lines[nextR].trim();
                }
                nextR++;
            }
            context.footnotes[fnId] = fnContent;
            r = nextR - 1;
        } else if (refMatch) {
            const key = refMatch[1].toLowerCase().trim();
            const url = refMatch[2];
            const title = refMatch[3] || refMatch[4] || refMatch[5] || "";
            context.references[key] = { url, title };
        } else if (abbrMatch) {
            // Ignored abbreviation definition
        } else {
            cleanedLines.push(l);
        }
    }

    const startsTableAt = (index) =>
        index + 1 < cleanedLines.length &&
        cleanedLines[index].includes("|") &&
        cleanedLines[index + 1].includes("|");

    let i = 0;
    while (i < cleanedLines.length) {
        let line = cleanedLines[i];

        // Skip empty lines
        if (!line.trim()) {
            i++;
            continue;
        }

        // HTML Comments <!-- ... -->
        if (line.trim().startsWith("<!--") && !/^<!--\s*toc\s*-->$/i.test(line.trim())) {
            while (i < cleanedLines.length && !cleanedLines[i].includes("-->")) {
                i++;
            }
            i++;
            continue;
        }

        // Table of Contents placeholder: [TOC], [toc], [[toc]], [[_TOC_]], <!-- toc -->
        if (/^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(line.trim())) {
            if (options.toc !== false) {
                const tocOptions = typeof options.toc === "object" ? { ...options, ...options.toc } : options;
                output.push(generateTOC(markdown, tocOptions));
                hasToc = true;
            }
            i++;
            continue;
        }

        // Fenced Code Blocks (```lang or ~~~lang)
        const fencedBlock = readFencedCodeBlock(cleanedLines, i);
        if (fencedBlock) {
            output.push(renderCodeBlock(fencedBlock));
            i = fencedBlock.end;
            continue;
        }

        // Indented Code Blocks (4 spaces or 1 tab)
        const indentedBlock = !getListItemMatch(line) ? readIndentedCodeBlock(cleanedLines, i) : null;
        if (indentedBlock) {
            output.push(renderCodeBlock(indentedBlock));
            i = indentedBlock.end;
            continue;
        }

        // Display Math: $$ ... $$ or \[ ... \]
        if (line.trim() === "$$" || line.trim() === "\\[") {
            const closing = line.trim() === "$$" ? "$$" : "\\]";
            const mathLines = [];
            i++;
            while (i < cleanedLines.length && cleanedLines[i].trim() !== closing) {
                mathLines.push(cleanedLines[i]);
                i++;
            }
            if (i < cleanedLines.length) i++;
            output.push(`<div class="math display">${escapeHtml(mathLines.join("\n"))}</div>`);
            continue;
        }

        // Setext Headings (Level 1: ===, Level 2: ---)
        if (i + 1 < cleanedLines.length && line.trim() && !line.match(/^\s{0,3}(?:[-*+]|\d+[.)]|>|\|)/)) {
            const nextLine = cleanedLines[i + 1].trim();
            if (/^={2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const content = parseInline(rawHeader, context);
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                output.push(`<h1 id="${slug}"${headingClass}>${content}</h1>`);
                i += 2;
                continue;
            } else if (/^-{2,}\s*$/.test(nextLine)) {
                const rawHeader = line.trim();
                const content = parseInline(rawHeader, context);
                const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
                output.push(`<h2 id="${slug}"${headingClass}>${content}</h2>`);
                i += 2;
                continue;
            }
        }

        // Horizontal Rules (---, ***, ___ with optional spaces)
        if (/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(line)) {
            output.push("<hr>");
            i++;
            continue;
        }

        // ATX Headers (# H1 to ###### H6)
        const headerMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headerMatch) {
            const level = headerMatch[1].length;
            let rawHeader = headerMatch[2].replace(/\s*#+\s*$/, "").trim();
            const explicitMatch = rawHeader.match(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/);
            const slug = getUniqueSlug(rawHeader, slugCounts, slugPrefix);
            if (explicitMatch) {
                rawHeader = rawHeader.replace(/\s*\{#([a-zA-Z0-9_-]+)[^}]*\}\s*$/, "").trim();
            }
            const content = parseInline(rawHeader, context);
            output.push(`<h${level} id="${slug}"${headingClass}>${content}</h${level}>`);
            i++;
            continue;
        }

        // Blockquotes & GitHub Alerts
        if (line.trim().startsWith(">")) {
            const noteLines = [];
            while (i < cleanedLines.length && (cleanedLines[i].trim().startsWith(">") || (cleanedLines[i].trim() && noteLines.length > 0 && !cleanedLines[i].match(/^\s{0,3}(?:#{1,6}|`{3,}|~{3,}|[-*+]|\d+[.)]|\|)/)))) {
                if (cleanedLines[i].trim().startsWith(">")) {
                    noteLines.push(cleanedLines[i].trim().replace(/^>\s?/, ""));
                } else {
                    noteLines.push(cleanedLines[i].trim());
                }
                i++;
            }

            const rawBlock = noteLines.join("\n").trim();
            const firstLine = rawBlock.split("\n")[0];
            const alertMatch = firstLine.match(/^\[!([a-zA-Z0-9_-]+)\]-?\s*(.*)$/i);
            const classAttr = noteClass ? ` class="${escapeHtml(noteClass)}"` : "";

            if (alertMatch) {
                const type = alertMatch[1].toUpperCase();
                const inlineTitle = alertMatch[2].trim();
                const body = rawBlock.slice(firstLine.length).trim();
                const titleHeader = inlineTitle ? `<strong>${type}: ${escapeHtml(inlineTitle)}</strong>` : `<strong>${type}</strong>`;
                const noteContent = parseMarkdownToHTML(body, nestedOptions);
                output.push(`<div${classAttr}>${titleHeader}\n${noteContent}</div>`);
            } else {
                if (!rawBlock.includes("\n\n") && !rawBlock.startsWith("- ") && !rawBlock.startsWith("* ")) {
                    const noteContent = parseInline(rawBlock, context);
                    output.push(`<div${classAttr}>${noteContent}</div>`);
                } else {
                    const noteContent = parseMarkdownToHTML(rawBlock, nestedOptions);
                    output.push(`<div${classAttr}>\n${noteContent}\n</div>`);
                }
            }
            continue;
        }

        // Tables
        if (startsTableAt(i)) {
            const tableLines = [];
            while (i < cleanedLines.length && (cleanedLines[i].trim().startsWith("|") || cleanedLines[i].includes("|"))) {
                tableLines.push(cleanedLines[i].trim());
                i++;
            }

            if (tableLines.length >= 2) {
                const parseRow = (rowStr) =>
                    splitTableRow(rowStr).map((c) => parseInline(c.trim(), context));

                const headers = parseRow(tableLines[0]);
                const isSeparator = /^\|?\s*:?-+:?\s*(?:\|?\s*:?-+:?\s*\|?)+$/.test(tableLines[1]);
                const alignments = [];

                if (isSeparator) {
                    const sepCells = splitTableRow(tableLines[1]);
                    sepCells.forEach((cell) => {
                        const trimmed = cell.trim();
                        if (trimmed.startsWith(":") && trimmed.endsWith(":")) alignments.push(" style=\"text-align: center;\"");
                        else if (trimmed.endsWith(":")) alignments.push(" style=\"text-align: right;\"");
                        else if (trimmed.startsWith(":")) alignments.push(" style=\"text-align: left;\"");
                        else alignments.push("");
                    });
                }

                const bodyStart = isSeparator ? 2 : 1;
                const containerClassAttr = tableContainerClass ? ` class="${escapeHtml(tableContainerClass)}"` : "";

                let tableHtml = `<div${containerClassAttr}><table><thead><tr>`;
                headers.forEach((h, idx) => {
                    const style = alignments[idx] || "";
                    tableHtml += `<th${style}>${h}</th>`;
                });
                tableHtml += "</tr></thead><tbody>";

                for (let r = bodyStart; r < tableLines.length; r++) {
                    const cells = parseRow(tableLines[r]);
                    tableHtml += "<tr>";
                    for (let c = 0; c < headers.length; c++) {
                        const cellVal = cells[c] !== undefined ? cells[c] : "";
                        const style = alignments[c] || "";
                        tableHtml += `<td${style}>${cellVal}</td>`;
                    }
                    tableHtml += "</tr>";
                }
                tableHtml += "</tbody></table></div>";
                output.push(tableHtml);
                continue;
            }
        }

        // Definition Lists (Term \n : Definition)
        if (i + 1 < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i + 1]) && !getListItemMatch(line)) {
            const term = parseInline(line.trim(), context);
            const defs = [];
            i++;
            while (i < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i])) {
                defs.push(parseInline(cleanedLines[i].trim().replace(/^:\s*/, ""), context));
                i++;
            }
            let dlHtml = `<dl><dt>${term}</dt>`;
            defs.forEach((d) => {
                dlHtml += `<dd>${d}</dd>`;
            });
            dlHtml += `</dl>`;
            output.push(dlHtml);
            continue;
        }

        // Lists
        if (getListItemMatch(line)) {
            let listHtml = "";
            const stack = [];

            while (i < cleanedLines.length) {
                const currentLine = cleanedLines[i];
                let itemMatch = getListItemMatch(currentLine);

                if (!itemMatch && currentLine.trim() && stack.length) {
                    const indent = getIndentWidth(currentLine);
                    let owner = stack.length - 1;
                    while (owner >= 0 && stack[owner].contentIndent > indent) owner--;
                    const block = owner >= 0 ? readFencedCodeBlock(cleanedLines, i, stack[owner].contentIndent) || readIndentedCodeBlock(cleanedLines, i, stack[owner].contentIndent) : null;
                    if (block) {
                        while (stack.length - 1 > owner) {
                            const popped = stack.pop();
                            listHtml += `</li></${popped.type}>`;
                        }
                        listHtml += renderCodeBlock(block);
                        i = block.end;
                        continue;
                    }
                }

                if (isListBlockBoundary(currentLine)) break;

                if (itemMatch) {
                    let block;
                    while (itemMatch) {
                        const { indent, contentIndent, start, type, prefix, text } = itemMatch;
                        const child = getListItemMatch(text, contentIndent);
                        block = child ? null : readFencedCodeBlock(cleanedLines, i, contentIndent, text);
                        const renderedText = prefix + (child ? "" : block ? renderCodeBlock(block) : parseInline(text, context));

                        while (stack.length && stack[stack.length - 1].indent > indent) {
                            const popped = stack.pop();
                            listHtml += `</li></${popped.type}>`;
                        }

                        const top = stack[stack.length - 1];
                        if (top && top.indent === indent) {
                            listHtml += "</li>";
                            if (top.type !== type) {
                                listHtml += `</${top.type}>`;
                                stack.pop();
                            }
                        }

                        if (!stack.length || stack[stack.length - 1].indent < indent) {
                            const startAttr = type === "ol" && start !== 1 ? ` start="${start}"` : "";
                            listHtml += `<${type}${startAttr}>`;
                            stack.push({ type, indent, contentIndent });
                        }
                        stack[stack.length - 1].contentIndent = contentIndent;
                        listHtml += `<li>${renderedText}`;
                        itemMatch = child;
                    }
                    i = block ? block.end : i + 1;
                } else if (!currentLine.trim()) {
                    let peek = i + 1;
                    while (peek < cleanedLines.length && !cleanedLines[peek].trim()) {
                        peek++;
                    }
                    const peekIndent = peek < cleanedLines.length ? getIndentWidth(cleanedLines[peek]) : -1;
                    if (peek < cleanedLines.length && (getListItemMatch(cleanedLines[peek]) || stack.some(item => peekIndent >= item.contentIndent))) {
                        i = peek;
                        continue;
                    }
                    break;
                } else {
                    const leadingSpaces = getIndentWidth(currentLine);
                    if (stack.length > 0 && leadingSpaces >= 2) {
                        listHtml += ` ${parseInline(currentLine.trim(), context)}`;
                        i++;
                    } else {
                        break;
                    }
                }
            }

            while (stack.length > 0) {
                const popped = stack.pop();
                listHtml += `</li></${popped.type}>`;
            }

            output.push(listHtml);
            continue;
        }

        // Raw HTML Blocks
        const htmlBlockMatch = line.match(/^\s{0,3}<(details|summary|section|article|figure|figcaption|blockquote|table|thead|tbody|tfoot|tr|th|td|ul|ol|li|dl|dt|dd|audio|video|picture|div|p|a)\b[^>]*>/i);
        if (htmlBlockMatch) {
            const blockTag = htmlBlockMatch[1].toLowerCase();
            const closingTagPattern = new RegExp(`</${blockTag}>`, "i");
            const htmlLines = [line];
            if (!closingTagPattern.test(line) && !line.endsWith("/>") && blockTag !== "summary") {
                i++;
                while (i < cleanedLines.length) {
                    htmlLines.push(cleanedLines[i]);
                    if (closingTagPattern.test(cleanedLines[i])) {
                        i++;
                        break;
                    }
                    i++;
                }
            } else {
                i++;
            }
            const rawHtml = htmlLines.join("\n");
            if (blockTag === "details" && !options.allowUnsafeHtml) {
                const detailsMatch = rawHtml.match(/^(<details\b[^>]*>)\s*\n?(<summary\b[^>]*>[\s\S]*?<\/summary>)\s*\n?([\s\S]*?)\s*<\/details>$/i);
                if (detailsMatch) {
                    const opening = sanitizeHtmlFragment(detailsMatch[1], options);
                    const summary = sanitizeHtmlFragment(detailsMatch[2], options);
                    const body = parseMarkdownToHTML(detailsMatch[3].trim(), nestedOptions);
                    output.push(`${opening}\n${summary}\n${body}\n</details>`);
                    continue;
                }
            }
            output.push(sanitizeHtmlFragment(rawHtml, options));
            continue;
        }

        // Paragraphs
        const paragraphLines = [];
        while (
            i < cleanedLines.length &&
            cleanedLines[i].trim() &&
            !getFenceMatch(cleanedLines[i]) &&
            !/^\s{0,3}(?:\*(?:\s*\*){2,}|-(?:\s*-){2,}|_(?:\s*_){2,})\s*$/.test(cleanedLines[i]) &&
            !cleanedLines[i].match(/^\s{0,3}#{1,6}\s+/) &&
            !cleanedLines[i].trim().startsWith(">") &&
            !startsTableAt(i) &&
            !getListItemMatch(cleanedLines[i]) &&
            !cleanedLines[i].trim().startsWith("<!--") &&
            !/^\s*(?:\[(?:TOC|toc|\[toc\]|_TOC_|\[_TOC_\])\]|<!--\s*toc\s*-->)\s*$/i.test(cleanedLines[i].trim()) &&
            !cleanedLines[i].match(/^\s{0,3}<(details|summary|section|article|figure|figcaption|blockquote|table|thead|tbody|tfoot|tr|th|td|ul|ol|li|dl|dt|dd|audio|video|picture|div|p|a)\b[^>]*>/i) &&
            !(getIndentWidth(cleanedLines[i]) >= 4 && paragraphLines.length === 0)
            ) {
            if (i + 1 < cleanedLines.length && /^(={2,}|-{2,})\s*$/.test(cleanedLines[i + 1].trim())) {
                break;
            }
            if (i + 1 < cleanedLines.length && /^\s{0,3}:[ \t]+/.test(cleanedLines[i + 1])) {
                break;
            }
            paragraphLines.push(cleanedLines[i]);
            i++;
        }

        if (paragraphLines.length > 0) {
            const formattedParas = [];
            let currentP = [];
            for (let p = 0; p < paragraphLines.length; p++) {
                const pLine = paragraphLines[p];
                if (pLine.endsWith("  ") || pLine.endsWith("\\")) {
                    currentP.push(pLine.replace(/(\\|\s{2})$/, ""));
                    formattedParas.push(currentP.join(" "));
                    currentP = [];
                } else {
                    currentP.push(pLine.trim());
                }
            }
            if (currentP.length > 0) {
                formattedParas.push(currentP.join(" "));
            }
            const pContent = formattedParas.map(p => parseInline(p, context)).join("<br>\n");
            output.push(`<p>${pContent}</p>`);
        }
    }

    // Append Footnotes if any were used
    if (context.footnoteOrder.length > 0) {
        let fnHtml = `<section class="footnotes">\n<hr>\n<ol>\n`;
        context.footnoteOrder.forEach((fnId) => {
            const rawContent = context.footnotes[fnId] || "";
            const parsedContent = parseInline(rawContent, context);
            const safeId = escapeHtmlAttribute(fnId);
            const referenceCount = context.footnoteReferenceCounts[fnId] || 1;
            let backrefs = "";
            for (let referenceIndex = 1; referenceIndex <= referenceCount; referenceIndex++) {
                const suffix = referenceIndex > 1 ? `-${referenceIndex}` : "";
                backrefs += ` <a href="#fnref-${safeId}${suffix}" class="footnote-backref">&#x21a9;&#xfe0e;</a>`;
            }
            fnHtml += `<li id="fn-${safeId}">${parsedContent}${backrefs}</li>\n`;
        });
        fnHtml += `</ol>\n</section>`;
        output.push(fnHtml);
    }

    if (options.toc?.injectIfAbsent && !hasToc) {
        const toc = generateTOC(markdown, { ...options, ...options.toc });
        if (toc) output.unshift(toc);
    }

    return output.join("\n");
}

/**
 * Fetches a Markdown file from a URL/path and renders its content into a target element.
 * @param {string} url - Path to .md file (e.g., 'md-showcase.md')
 * @param {HTMLElement|string} targetElement - DOM element or selector
 * @param {object} [options] - Options passed to parseMarkdownToHTML
 */
async function renderMarkdownFileToElement(url, targetElement, options = {}) {
    const container = typeof targetElement === "string"
        ? (typeof document !== "undefined" && document.querySelector ? document.querySelector(targetElement) : null)
        : targetElement;
    if (!container) return;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to render markdown file into target element: HTTP error ${response.status}`);
            return;
        }
        const markdown = await response.text();
        container.innerHTML = parseMarkdownToHTML(markdown, options);
    } catch (err) {
        console.error("Failed to render markdown file into target element:", err);
    }
}

// Backward-compatible alias functions
const parseMarkdownToModalHTML = parseMarkdownToHTML;
const renderMarkdownFileToModal = renderMarkdownFileToElement;

// Support both ES module / CommonJS and global browser usage
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        parseMarkdownToHTML,
        renderMarkdownFileToElement,
        extractHeadings,
        generateTOC,
        slugify,
        // Legacy aliases
        parseMarkdownToModalHTML,
        renderMarkdownFileToModal,
    };
} else {
    window.parseMarkdownToHTML = parseMarkdownToHTML;
    window.renderMarkdownFileToElement = renderMarkdownFileToElement;
    window.extractHeadings = extractHeadings;
    window.generateTOC = generateTOC;
    window.slugify = slugify;
    // Legacy aliases
    window.parseMarkdownToModalHTML = parseMarkdownToModalHTML;
    window.renderMarkdownFileToModal = renderMarkdownFileToModal;
}
