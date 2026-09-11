# audit: deletion of stale draft releases on ccsliinc/CloudeCode

date: 2026-09-10
authorised by the owner, verbatim: "2. i think this is safe so why not."

scope: DRAFT releases only, tags v1.0.0 through v1.0.32 inclusive.
a github release object is not a git tag. deleting a release does not delete
the tag. no `--cleanup-tag` was used on any call. tag state is recorded below,
before and after, on both remotes.

## kept, and why

| id | tag | state | reason |
|---|---|---|---|
| 378751709 | v1.0.31 | PUBLISHED | published twin of the in-range draft; the draft (378751396) goes, this stays |
| 379042483 | v1.0.33 | PUBLISHED | last Latest before ours |
| 386573886 | v1.0.34 | DRAFT | OUT OF AUTHORISED RANGE, untouched |
| 386571075 | v1.0.35 | DRAFT | OUT OF AUTHORISED RANGE, untouched |
| 386574754 | v1.0.36 | DRAFT | OUT OF AUTHORISED RANGE, untouched |
| 386283410 | v1.2.0 | PUBLISHED | current line |
| 386427339 | v1.2.1 | PUBLISHED | current line, marked Latest |

## deleted

| id | tag | draft | assets | bytes | asset name |
|---|---|---|---|---|---|
| 375960299 | v1.0.0 | true | 1 | 123931148 | Cloude.Code-1.0.0-arm64.dmg |
| 375962506 | v1.0.1 | true | 1 | 123938213 | Cloude.Code-1.0.1-arm64.dmg |
| 376472680 | v1.0.2 | true | 1 | 123931321 | Cloude.Code-1.0.2-arm64.dmg |
| 376547649 | v1.0.3 | true | 1 | 123924767 | Cloude.Code-1.0.3-arm64.dmg |
| 376730753 | v1.0.4 | true | 1 | 123979005 | Cloude.Code-1.0.4-arm64.dmg |
| 377205614 | v1.0.5 | true | 1 | 124047834 | Cloude.Code-1.0.5-arm64.dmg |
| 377295029 | v1.0.6 | true | 1 | 124084711 | Cloude.Code-1.0.6-arm64.dmg |
| 377320455 | v1.0.7 | true | 1 | 124087437 | Cloude.Code-1.0.7-arm64.dmg |
| 377432239 | v1.0.8 | true | 1 | 124081052 | Cloude.Code-1.0.8-arm64.dmg |
| 377833316 | v1.0.9 | true | 1 | 124084905 | Cloude.Code-1.0.9-arm64.dmg |
| 377862847 | v1.0.10 | true | 1 | 124076330 | Cloude.Code-1.0.10-arm64.dmg |
| 377886644 | v1.0.11 | true | 1 | 124080461 | Cloude.Code-1.0.11-arm64.dmg |
| 377890725 | v1.0.12 | true | 1 | 124080107 | Cloude.Code-1.0.12-arm64.dmg |
| 377897163 | v1.0.13 | true | 1 | 124082646 | Cloude.Code-1.0.13-arm64.dmg |
| 377907101 | v1.0.14 | true | 1 | 124081112 | Cloude.Code-1.0.14-arm64.dmg |
| 377921511 | v1.0.15 | true | 1 | 124091459 | Cloude.Code-1.0.15-arm64.dmg |
| 377927776 | v1.0.16 | true | 1 | 124106125 | Cloude.Code-1.0.16-arm64.dmg |
| 377932587 | v1.0.17 | true | 1 | 124106034 | Cloude.Code-1.0.17-arm64.dmg |
| 377937277 | v1.0.18 | true | 1 | 124106585 | Cloude.Code-1.0.18-arm64.dmg |
| 377946602 | v1.0.19 | true | 1 | 124106971 | Cloude.Code-1.0.19-arm64.dmg |
| 377954652 | v1.0.20 | true | 1 | 124107263 | Cloude.Code-1.0.20-arm64.dmg |
| 377960588 | v1.0.21 | true | 1 | 124114024 | Cloude.Code-1.0.21-arm64.dmg |
| 378011746 | v1.0.22 | true | 1 | 124112418 | Cloude.Code-1.0.22-arm64.dmg |
| 378015586 | v1.0.23 | true | 1 | 124114097 | Cloude.Code-1.0.23-arm64.dmg |
| 378060309 | v1.0.24 | true | 1 | 124115748 | Cloude.Code-1.0.24-arm64.dmg |
| 378069370 | v1.0.25 | true | 1 | 124116237 | Cloude.Code-1.0.25-arm64.dmg |
| 378077001 | v1.0.26 | true | 1 | 124116787 | Cloude.Code-1.0.26-arm64.dmg |
| 378544298 | v1.0.27 | true | 1 | 124109290 | Cloude.Code-1.0.27-arm64.dmg |
| 378558122 | v1.0.28 | true | 1 | 124130916 | Cloude.Code-1.0.28-arm64.dmg |
| 378589595 | v1.0.29 | true | 1 | 124142862 | Cloude.Code-1.0.29-arm64.dmg |
| 378725675 | v1.0.30 | true | 1 | 124481027 | Cloude.Code-1.0.30-arm64.dmg |
| 378751396 | v1.0.31 | true | 1 | 124507749 | Cloude.Code-1.0.31-arm64.dmg |
| 379027059 | v1.0.32 | true | 1 | 124507366 | Cloude.Code-1.0.32-arm64.dmg |

count: 33
bytes: 4095684007

## tag state BEFORE deletion (both remotes)

```
=== origin (git@github.com:ccsliinc/CloudeCode.git) ===
4ae68ecae7b3ebbed2ec0356681ab57f19aa60bd	refs/tags/v1.0.0
060457e4fd60456833cf3bfc0a2289a35ea6f040	refs/tags/v1.0.1
de695ef146f8c55045201f36034a388f400e7e52	refs/tags/v1.0.2
26fb0863e07d16d7f2da0a3edd23328a3200a0ea	refs/tags/v1.0.3
3e170c670491af44c14c6f55c00196d3ad5be0c9	refs/tags/v1.0.4
a27e9f71cdab488d7c0eef30cbc0ef54b95386fa	refs/tags/v1.0.5
820fd3077725107c277c70019ac208186c7390a4	refs/tags/v1.0.6
db22da336a9cea0d60b230e66bdb00a5a8e8d1af	refs/tags/v1.0.7
8b4830a4f94f6b98c3b47f666b2d1a259bf3adb0	refs/tags/v1.0.8
3dab7e204f301fab68e0c0e3613ff6dc7fdef0f0	refs/tags/v1.0.9
c881858bf3b15110bc378dfa18990c2ef7b87fb4	refs/tags/v1.0.10
168041f9b9077f0200a216819dbfbe638bc34917	refs/tags/v1.0.11
80327878c792aceb18923dc069abaaf7851a3039	refs/tags/v1.0.12
99de292eec581ffd24d735b77b486f9de12ef334	refs/tags/v1.0.13
ca796f60f2024e20d2c1a7d4c0d77d6d7eeea08b	refs/tags/v1.0.14
253780368dbddeb262c36c14d00706e262c0a3ae	refs/tags/v1.0.15
c02f34ad872a270490820941ff8914054b8d640d	refs/tags/v1.0.16
19c13b1a5e321c77226ec989aa316c0ff602c8e8	refs/tags/v1.0.17
16bc4f896059e627824736d89701bb972295b80c	refs/tags/v1.0.18
79f69d9a8e69889a1cb454d006d56c4825ce25a8	refs/tags/v1.0.19
3cb4f6ff42cf0a8da2f494e9496d1ddc41e31028	refs/tags/v1.0.20
cb7af52ae095ea9f1c1086d5b3f61967501896f4	refs/tags/v1.0.21
eb09d42e29f291d2ee0f2c183511b6d1a4578845	refs/tags/v1.0.22
f2ba9198153f51632b7a3139c6a7c457e9608556	refs/tags/v1.0.23
76110c8750ba1e1ccd6b9ac58b5179a7deb2f08f	refs/tags/v1.0.24
9f650bcc67d39d76c5a256f0b2aba71f43df99ba	refs/tags/v1.0.25
65ed83485595cdf10fedfb81c7f331f7d74dedbc	refs/tags/v1.0.26
6deb6233c8e0c5bf28a959ab0593ab8ee698d67f	refs/tags/v1.0.27
fe8b0c00af4234e1c87bb2b8594956a943118487	refs/tags/v1.0.28
2330f7aba816c081ff0fd3f5f4840b098908f1a5	refs/tags/v1.0.29
07e9c6ff49e978da7e457ef73323b5b6b68752f4	refs/tags/v1.0.30
fca4c311bda7866eddec283d0e69b0bc7fcb6eae	refs/tags/v1.0.31
29deed1f8315af63f9b0b9dcd9164c2cc2fd189f	refs/tags/v1.0.32
6de50e80b2ac4dfd9a894f198b8ab29f3180be31	refs/tags/v1.0.33
88c49eb0052ea368249a438f4544269cf27bb1ec	refs/tags/v1.0.34
73da02aa5c244f01a367f9fe9f9a36accc07856c	refs/tags/v1.0.35
bc683dd69ebdb3ff682df79b1880b44b15fa6c87	refs/tags/v1.0.36
f4ede4c577e5023792766ed5b6285c8c0b6c81ab	refs/tags/v1.2.0
54d95d1a90f1ecfd603c9d871b1d8abf76c744cc	refs/tags/v1.2.1
=== adamdev (git@github.com:Adoom666/CloudeCodeDev.git) ===
4ae68ecae7b3ebbed2ec0356681ab57f19aa60bd	refs/tags/v1.0.0
060457e4fd60456833cf3bfc0a2289a35ea6f040	refs/tags/v1.0.1
de695ef146f8c55045201f36034a388f400e7e52	refs/tags/v1.0.2
26fb0863e07d16d7f2da0a3edd23328a3200a0ea	refs/tags/v1.0.3
3e170c670491af44c14c6f55c00196d3ad5be0c9	refs/tags/v1.0.4
a27e9f71cdab488d7c0eef30cbc0ef54b95386fa	refs/tags/v1.0.5
820fd3077725107c277c70019ac208186c7390a4	refs/tags/v1.0.6
db22da336a9cea0d60b230e66bdb00a5a8e8d1af	refs/tags/v1.0.7
8b4830a4f94f6b98c3b47f666b2d1a259bf3adb0	refs/tags/v1.0.8
3dab7e204f301fab68e0c0e3613ff6dc7fdef0f0	refs/tags/v1.0.9
c881858bf3b15110bc378dfa18990c2ef7b87fb4	refs/tags/v1.0.10
168041f9b9077f0200a216819dbfbe638bc34917	refs/tags/v1.0.11
80327878c792aceb18923dc069abaaf7851a3039	refs/tags/v1.0.12
99de292eec581ffd24d735b77b486f9de12ef334	refs/tags/v1.0.13
ca796f60f2024e20d2c1a7d4c0d77d6d7eeea08b	refs/tags/v1.0.14
253780368dbddeb262c36c14d00706e262c0a3ae	refs/tags/v1.0.15
c02f34ad872a270490820941ff8914054b8d640d	refs/tags/v1.0.16
19c13b1a5e321c77226ec989aa316c0ff602c8e8	refs/tags/v1.0.17
16bc4f896059e627824736d89701bb972295b80c	refs/tags/v1.0.18
79f69d9a8e69889a1cb454d006d56c4825ce25a8	refs/tags/v1.0.19
3cb4f6ff42cf0a8da2f494e9496d1ddc41e31028	refs/tags/v1.0.20
cb7af52ae095ea9f1c1086d5b3f61967501896f4	refs/tags/v1.0.21
eb09d42e29f291d2ee0f2c183511b6d1a4578845	refs/tags/v1.0.22
f2ba9198153f51632b7a3139c6a7c457e9608556	refs/tags/v1.0.23
76110c8750ba1e1ccd6b9ac58b5179a7deb2f08f	refs/tags/v1.0.24
9f650bcc67d39d76c5a256f0b2aba71f43df99ba	refs/tags/v1.0.25
65ed83485595cdf10fedfb81c7f331f7d74dedbc	refs/tags/v1.0.26
6deb6233c8e0c5bf28a959ab0593ab8ee698d67f	refs/tags/v1.0.27
fe8b0c00af4234e1c87bb2b8594956a943118487	refs/tags/v1.0.28
2330f7aba816c081ff0fd3f5f4840b098908f1a5	refs/tags/v1.0.29
07e9c6ff49e978da7e457ef73323b5b6b68752f4	refs/tags/v1.0.30
fca4c311bda7866eddec283d0e69b0bc7fcb6eae	refs/tags/v1.0.31
29deed1f8315af63f9b0b9dcd9164c2cc2fd189f	refs/tags/v1.0.32
834fd5811f40a2b400375d8ac53be9e06b2abaf3	refs/tags/v1.0.33
88c49eb0052ea368249a438f4544269cf27bb1ec	refs/tags/v1.0.34
73da02aa5c244f01a367f9fe9f9a36accc07856c	refs/tags/v1.0.35
bc683dd69ebdb3ff682df79b1880b44b15fa6c87	refs/tags/v1.0.36
f4ede4c577e5023792766ed5b6285c8c0b6c81ab	refs/tags/v1.2.0
54d95d1a90f1ecfd603c9d871b1d8abf76c744cc	refs/tags/v1.2.1
```

## deletion RESULT

executed 2026-09-10 via `gh api -X DELETE repos/ccsliinc/CloudeCode/releases/<id>`,
one id at a time, each re-read immediately before its delete and refused unless
the live record still said `draft: true` and the tag was still in range.

deleted: 33
skipped: 0
failed:  0
reclaimed: 4095684007 bytes (3.81 GB)

v1.0.34, v1.0.35 and v1.0.36 are ALSO drafts on this repo and were NOT touched:
they sit outside the authorised v1.0.0 to v1.0.32 range. flagged, not acted on.

## releases remaining

```
v1.0.31	PUBLISHED	-
v1.0.33	PUBLISHED	-
v1.0.34	DRAFT	-
v1.0.35	DRAFT	-
v1.0.36	DRAFT	-
v1.2.0	PUBLISHED	-
v1.2.1	PUBLISHED	LATEST
```

## tag state AFTER deletion (both remotes)

byte-identical to the BEFORE block above. `diff` of the two listings is EMPTY:
every tag in v1.0.0..v1.0.36 and v1.2.0..v1.2.1 still resolves, to the same
commit sha, on BOTH `origin` (ccsliinc/CloudeCode) and `adamdev`
(Adoom666/CloudeCodeDev). 39 tag refs per remote, 78 lines total, unchanged.

```
=== origin (git@github.com:ccsliinc/CloudeCode.git) ===
4ae68ecae7b3ebbed2ec0356681ab57f19aa60bd	refs/tags/v1.0.0
060457e4fd60456833cf3bfc0a2289a35ea6f040	refs/tags/v1.0.1
de695ef146f8c55045201f36034a388f400e7e52	refs/tags/v1.0.2
26fb0863e07d16d7f2da0a3edd23328a3200a0ea	refs/tags/v1.0.3
3e170c670491af44c14c6f55c00196d3ad5be0c9	refs/tags/v1.0.4
a27e9f71cdab488d7c0eef30cbc0ef54b95386fa	refs/tags/v1.0.5
820fd3077725107c277c70019ac208186c7390a4	refs/tags/v1.0.6
db22da336a9cea0d60b230e66bdb00a5a8e8d1af	refs/tags/v1.0.7
8b4830a4f94f6b98c3b47f666b2d1a259bf3adb0	refs/tags/v1.0.8
3dab7e204f301fab68e0c0e3613ff6dc7fdef0f0	refs/tags/v1.0.9
c881858bf3b15110bc378dfa18990c2ef7b87fb4	refs/tags/v1.0.10
168041f9b9077f0200a216819dbfbe638bc34917	refs/tags/v1.0.11
80327878c792aceb18923dc069abaaf7851a3039	refs/tags/v1.0.12
99de292eec581ffd24d735b77b486f9de12ef334	refs/tags/v1.0.13
ca796f60f2024e20d2c1a7d4c0d77d6d7eeea08b	refs/tags/v1.0.14
253780368dbddeb262c36c14d00706e262c0a3ae	refs/tags/v1.0.15
c02f34ad872a270490820941ff8914054b8d640d	refs/tags/v1.0.16
19c13b1a5e321c77226ec989aa316c0ff602c8e8	refs/tags/v1.0.17
16bc4f896059e627824736d89701bb972295b80c	refs/tags/v1.0.18
79f69d9a8e69889a1cb454d006d56c4825ce25a8	refs/tags/v1.0.19
3cb4f6ff42cf0a8da2f494e9496d1ddc41e31028	refs/tags/v1.0.20
cb7af52ae095ea9f1c1086d5b3f61967501896f4	refs/tags/v1.0.21
eb09d42e29f291d2ee0f2c183511b6d1a4578845	refs/tags/v1.0.22
f2ba9198153f51632b7a3139c6a7c457e9608556	refs/tags/v1.0.23
76110c8750ba1e1ccd6b9ac58b5179a7deb2f08f	refs/tags/v1.0.24
9f650bcc67d39d76c5a256f0b2aba71f43df99ba	refs/tags/v1.0.25
65ed83485595cdf10fedfb81c7f331f7d74dedbc	refs/tags/v1.0.26
6deb6233c8e0c5bf28a959ab0593ab8ee698d67f	refs/tags/v1.0.27
fe8b0c00af4234e1c87bb2b8594956a943118487	refs/tags/v1.0.28
2330f7aba816c081ff0fd3f5f4840b098908f1a5	refs/tags/v1.0.29
07e9c6ff49e978da7e457ef73323b5b6b68752f4	refs/tags/v1.0.30
fca4c311bda7866eddec283d0e69b0bc7fcb6eae	refs/tags/v1.0.31
29deed1f8315af63f9b0b9dcd9164c2cc2fd189f	refs/tags/v1.0.32
6de50e80b2ac4dfd9a894f198b8ab29f3180be31	refs/tags/v1.0.33
88c49eb0052ea368249a438f4544269cf27bb1ec	refs/tags/v1.0.34
73da02aa5c244f01a367f9fe9f9a36accc07856c	refs/tags/v1.0.35
bc683dd69ebdb3ff682df79b1880b44b15fa6c87	refs/tags/v1.0.36
f4ede4c577e5023792766ed5b6285c8c0b6c81ab	refs/tags/v1.2.0
54d95d1a90f1ecfd603c9d871b1d8abf76c744cc	refs/tags/v1.2.1
=== adamdev (git@github.com:Adoom666/CloudeCodeDev.git) ===
4ae68ecae7b3ebbed2ec0356681ab57f19aa60bd	refs/tags/v1.0.0
060457e4fd60456833cf3bfc0a2289a35ea6f040	refs/tags/v1.0.1
de695ef146f8c55045201f36034a388f400e7e52	refs/tags/v1.0.2
26fb0863e07d16d7f2da0a3edd23328a3200a0ea	refs/tags/v1.0.3
3e170c670491af44c14c6f55c00196d3ad5be0c9	refs/tags/v1.0.4
a27e9f71cdab488d7c0eef30cbc0ef54b95386fa	refs/tags/v1.0.5
820fd3077725107c277c70019ac208186c7390a4	refs/tags/v1.0.6
db22da336a9cea0d60b230e66bdb00a5a8e8d1af	refs/tags/v1.0.7
8b4830a4f94f6b98c3b47f666b2d1a259bf3adb0	refs/tags/v1.0.8
3dab7e204f301fab68e0c0e3613ff6dc7fdef0f0	refs/tags/v1.0.9
c881858bf3b15110bc378dfa18990c2ef7b87fb4	refs/tags/v1.0.10
168041f9b9077f0200a216819dbfbe638bc34917	refs/tags/v1.0.11
80327878c792aceb18923dc069abaaf7851a3039	refs/tags/v1.0.12
99de292eec581ffd24d735b77b486f9de12ef334	refs/tags/v1.0.13
ca796f60f2024e20d2c1a7d4c0d77d6d7eeea08b	refs/tags/v1.0.14
253780368dbddeb262c36c14d00706e262c0a3ae	refs/tags/v1.0.15
c02f34ad872a270490820941ff8914054b8d640d	refs/tags/v1.0.16
19c13b1a5e321c77226ec989aa316c0ff602c8e8	refs/tags/v1.0.17
16bc4f896059e627824736d89701bb972295b80c	refs/tags/v1.0.18
79f69d9a8e69889a1cb454d006d56c4825ce25a8	refs/tags/v1.0.19
3cb4f6ff42cf0a8da2f494e9496d1ddc41e31028	refs/tags/v1.0.20
cb7af52ae095ea9f1c1086d5b3f61967501896f4	refs/tags/v1.0.21
eb09d42e29f291d2ee0f2c183511b6d1a4578845	refs/tags/v1.0.22
f2ba9198153f51632b7a3139c6a7c457e9608556	refs/tags/v1.0.23
76110c8750ba1e1ccd6b9ac58b5179a7deb2f08f	refs/tags/v1.0.24
9f650bcc67d39d76c5a256f0b2aba71f43df99ba	refs/tags/v1.0.25
65ed83485595cdf10fedfb81c7f331f7d74dedbc	refs/tags/v1.0.26
6deb6233c8e0c5bf28a959ab0593ab8ee698d67f	refs/tags/v1.0.27
fe8b0c00af4234e1c87bb2b8594956a943118487	refs/tags/v1.0.28
2330f7aba816c081ff0fd3f5f4840b098908f1a5	refs/tags/v1.0.29
07e9c6ff49e978da7e457ef73323b5b6b68752f4	refs/tags/v1.0.30
fca4c311bda7866eddec283d0e69b0bc7fcb6eae	refs/tags/v1.0.31
29deed1f8315af63f9b0b9dcd9164c2cc2fd189f	refs/tags/v1.0.32
834fd5811f40a2b400375d8ac53be9e06b2abaf3	refs/tags/v1.0.33
88c49eb0052ea368249a438f4544269cf27bb1ec	refs/tags/v1.0.34
73da02aa5c244f01a367f9fe9f9a36accc07856c	refs/tags/v1.0.35
bc683dd69ebdb3ff682df79b1880b44b15fa6c87	refs/tags/v1.0.36
f4ede4c577e5023792766ed5b6285c8c0b6c81ab	refs/tags/v1.2.0
54d95d1a90f1ecfd603c9d871b1d8abf76c744cc	refs/tags/v1.2.1
```
