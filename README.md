# MemeCut AI

Een interactieve ontwerpversie van een gamingeditor voor langere YouTube-video’s in 16:9. De demo laat zien waar een reactie, meme, tekst, geluid of zoom de grap kan versterken. De maker kan meteen exporteren of eerst momenten aanpassen.

## Proberen

Open `dist/index.html` in je browser. Je kunt de editor ook via een lokale server openen. Voer vanuit de map `memecut-ai` uit:

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open daarna `http://127.0.0.1:8080`.

- De Minecraft-demo opent bij de lavaval rond 00:13. Het vooraf samengestelde plan laat zien hoe de stemreactie ‘NEEEE!’ tot een dramatisch geluid, een zoom en de tekst ‘BROOO 💀’ leidt.
- Importeer eigen gameplay om die af te spelen en lokaal op audiopieken te analyseren. Bij geschikte pieken stelt de editor momenten voor. De analyse gebruikt volume als signaal. Gameplaygebeurtenissen en de betekenis van spraak vallen onder het backendontwerp hieronder.
- Selecteer een moment om het terug te kijken. Pas de tekst, meme of effecten aan, of schakel het moment uit. Download het montageplan als JSON.
- Exporteer eigen videomateriaal met de actieve effecten tot 720p. De renderer verwerkt de video lokaal in afspeelsnelheid en biedt MP4 op browsers die dat formaat kunnen opnemen, of WebM waar dat wordt ondersteund. Het videobestand blijft op je apparaat.

Het demobeeld staat in `dist/assets/lava.png` en is gemaakt met de ingebouwde ImageGen-tool. Gebruikte prompt:

> Use case: stylized-concept. Single wide 16:9 gameplay still as the preview image in a Minecraft gameplay editing app. An authentic Minecraft-like first-person gameplay capture in a dangerous underground cavern of blocky dark slate and gray cobblestone with vivid incandescent orange and red lava pools and a short block bridge, viewpoint just at the edge of the bridge, a mint teal pixelated diamond pickaxe held at lower right. Strong orange bounce light on the blocks with deep bluish charcoal cave recesses, crisp pixel textures and game-like lighting, detailed well-lit upper part, distinct depth, no overlay, no letters, no watermarks, no HUD, no people. Landscape, fill entire frame.

## Backendontwerp voor v0.1

1. **Inlezen.** Node.js neemt een gameplayvideo van 2–10 minuten aan en start een achtergrondtaak. FFmpeg controleert de bron, leest de audiosporen uit en maakt een lichte analyseversie. Gebruik een apart microfoonspoor als het beschikbaar is.
2. **Momenten vinden.** Spraakherkenning levert een transcript met tijdcodes. Een beeldmodel bekijkt gespreide gameplayframes en extra frames rond reacties en scènewisselingen. Het systeem groepeert aanwijzingen rond hetzelfde tijdstip. Een plots verlies met een directe stemreactie krijgt bijvoorbeeld voorrang boven een willekeurige volumepiek.
3. **Montage plannen.** Een taalmodel kiest uit een bibliotheek met eigen of gelicentieerde assets. Elk item heeft tags zoals `fail`, `schrik`, `overwinning` of `stilte`, plus een duur en volume. Het plan bevat de bronintervallen die de montage behoudt en per moment de tijdcode, aanleiding, gekozen asset, tekst en effecten. Behoud de aanloop naar de grap en de eerste reactie. Geef gesproken punchlines ruimte door effecten kort te houden en het geluid eronder te dempen.
4. **Valideren en tonen.** De server controleert tijdcodes tegen de bronduur, verifieert asset-ID’s en voorkomt conflicterende effecten. Bij zwakke aanwijzingen kan het plan een fragment zonder effect laten. De editor toont de voorgestelde momenten en kan het gevalideerde plan meteen gebruiken of na aanpassingen opnieuw laten valideren.
5. **Renderen.** FFmpeg voert de cuts uit, mixt bron en effecten en schrijft één 16:9 MP4. Een compositor zoals Remotion verzorgt geanimeerde tekst en overlays. De render vertaalt bronposities naar de uiteindelijke tijdlijn na cuts. Een mislukte render kan opnieuw worden uitgevoerd met hetzelfde opgeslagen plan.

Test de eerste versie met gameplay waarin vooraf een paar grappige momenten zijn gemarkeerd. Controleer of de aanloop en reactie intact blijven, de effecten inhoudelijk passen en de spraak verstaanbaar blijft in de export.
