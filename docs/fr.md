# Amplis AV Yamaha (YNCA)

Pilotez les zones de votre ampli AV Yamaha depuis Gladys, sur votre réseau
local, sans aucun cloud : état de marche, allumage, veille, volume (plafonné),
sourdine, entrée et programme sonore.

> **Jamais testé avec un vrai appareil.** Cette intégration n'a jamais été
> testée avec un vrai appareil : elle a été écrite à partir de la bibliothèque
> ynca et testée face à un ampli simulé seulement. Les retours des
> propriétaires sont les bienvenus. Intégration non officielle, sans lien avec
> Yamaha.

## Quels amplis

Les amplis Yamaha qui parlent **YNCA**, le protocole de contrôle réseau sur le
port TCP 50000 : la plupart des RX-V, RX-A (AVENTAGE), HTR et CX-A avec prise
réseau depuis 2010 environ, y compris les modèles MusicCast récents (YNCA et
MusicCast sont deux protocoles qu'un même ampli peut parler). Les zones de
l'ampli (zone principale, zones 2, 3, 4) sont trouvées d'elles-mêmes.

### YNCA ou MusicCast ?

[guim31/gladys-musiccast](https://github.com/guim31/gladys-musiccast) pilote les
appareils Yamaha par **MusicCast**, un autre protocole (HTTP). Cette
intégration parle **YNCA** :

- votre ampli est ancien et n'a pas MusicCast : utilisez cette intégration ;
- votre ampli est MusicCast (enceintes, barres de son, amplis récents) : les
  deux peuvent marcher. MusicCast couvre aussi des appareils qui ne sont pas
  des amplis ; YNCA donne les programmes sonores, les entrées et les zones
  tels que l'ampli les nomme.
- Utilisez **l'une ou l'autre** pour un même ampli, pas les deux : vous auriez
  deux appareils Gladys pour la même zone, et deux plafonds de volume.

## Avant de commencer

1. Sur l'ampli, activez la **veille réseau** (Network Standby, dans le menu
   Configuration, puis Réseau ; le nom varie selon le modèle). Sans elle, un
   ampli en veille quitte le réseau : il ne peut pas être allumé depuis Gladys
   et apparaît éteint.
2. Donnez à l'ampli une **adresse IP fixe** dans votre box (réservation DHCP).
   Les appareils Gladys sont liés à cette adresse : une nouvelle adresse donne
   de nouveaux appareils.
3. Un ampli accepte peu de connexions YNCA à la fois. Si un autre programme en
   garde une ouverte (Home Assistant `yamaha_ynca`, un script), l'intégration
   peut ne pas obtenir de réponse : le statut de l'intégration le dit alors.

## Configuration

- **Adresses IP des amplis** : séparées par des virgules, par exemple
  `192.168.1.50, 192.168.1.51`. Port 50000 par défaut ; un autre port s'écrit
  `192.168.1.50:50001`. Dix amplis au plus.
- **Plafond de volume (dB)** : le volume le plus fort que Gladys peut régler,
  de -80 à +16,5 dB, comme affiché sur l'écran de l'ampli. -20 dB par défaut.

Enregistrez : un appareil par zone apparaît dans l'onglet **Découverte** (par
exemple « RX-V673 Main zone », « RX-V673 Zone 2 », ou le nom de zone réglé sur
l'ampli). Créez ceux que vous voulez.

## Ce que fait chaque appareil

| Fonction        | Ce qu'elle fait                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power (marche)  | Lecture seule : 1 allumé, 0 en veille (ou ampli injoignable).                                                                                            |
| Power on        | Bouton : allume la zone.                                                                                                                                 |
| Standby         | Bouton : met la zone en veille.                                                                                                                          |
| Volume          | 0 à 100, plafonné (voir plus bas).                                                                                                                       |
| Mute (sourdine) | Bouton : chaque appui coupe ou rend le son (la sourdine en cours est lue d'abord).                                                                       |
| Input (entrée)  | Liste : les entrées de l'ampli (avec les noms réglés dessus), et « Main Zone Sync » pour les zones 2 à 4.                                                |
| Sound program   | Liste, zone principale seulement : Hall in Munich, Standard, 7ch Stereo... Un programme absent de votre modèle est refusé par l'ampli, et Gladys le dit. |

La marche est un état en lecture seule et deux boutons, jamais un
interrupteur : un « éteins tout » d'un assistant vocal ou d'une scène n'allume
ni n'éteint jamais votre ampli par surprise.

Les changements faits sur l'ampli, sa télécommande ou son application
remontent aussitôt dans Gladys (au plus une fois par seconde et par zone).

## Le volume et son plafond

YNCA travaille en dB, de -80,5 dB à +16,5 dB par pas de 0,5 dB. Gladys affiche
0 à 100, linéairement : **0 = -80,5 dB, 50 = -32 dB, 100 = +16,5 dB**.

- Un volume demandé depuis Gladys (tableau de bord, scène, assistant vocal)
  au-dessus du plafond est ramené au plafond, pas refusé : « volume 80 » donne
  le plafond.
- La limite de volume de l'ampli lui-même (son réglage « Max Volume ») plafonne
  aussi, quand elle est plus basse.
- **Rendre le son** depuis Gladys ramène d'abord au plafond un volume plus fort.
- **Allumer** depuis Gladys : si la zone se réveille au-dessus du plafond (son
  réglage de volume initial), le volume est ramené au plafond ; si l'ampli est
  lent à se réveiller (même s'il confirme l'allumage en retard), c'est
  revérifié toutes les 2,5 s, six fois.
- Un volume réglé sur l'ampli lui-même (bouton, télécommande, application)
  au-dessus du plafond est affiché tel quel, et n'est pas baissé pendant qu'il
  joue.

## Commandes et réponses

Chaque commande reçoit une réponse dans Gladys en moins de 4 secondes :

- faite : l'ampli l'a confirmée ;
- « Refused by the receiver (@RESTRICTED) » : l'ampli ne l'accepte pas
  maintenant (zone en veille, programme absent de ce modèle) ;
- « Sent, without confirmation » (envoyée, sans confirmation) : elle est
  partie mais l'ampli ne l'a pas confirmée ; l'état affiché suit ce que l'ampli
  fait vraiment ;
- « ... nothing sent » (rien d'envoyé) : l'ampli n'est pas connecté, ou la
  commande a trop attendu derrière d'autres ; elle n'est jamais envoyée en
  retard.

La sourdine passe avant les commandes qui attendent pour le même ampli. La
veille n'attend jamais : elle part aussitôt, et une commande encore en cours
pour cette zone n'envoie plus rien.

## Quand l'ampli ne répond pas

La connexion est rouverte après 10 s, puis à des intervalles doublés jusqu'à
5 minutes. Ses zones affichent la marche à 0, et le statut de l'intégration le
nomme. Le bouton **Vérifier les amplis** donne l'état de chaque ampli :
connecté ou non, modèle, et marche, volume et entrée de chaque zone.

## Limites

- Un appareil par zone, lié à l'adresse de l'ampli (YNCA ne donne pas de numéro
  de série).
- Pas de commande de lecture (lecture, pause, suivant) des sources réseau, pas
  de présélections du tuner, pas de scènes, pas de Zone B, pas de Pure Direct
  dans cette version.
- Adresses saisies seulement : pas de recherche automatique.
- Jamais testé avec un vrai appareil.

## Crédits

Le protocole YNCA est porté de la bibliothèque
[ynca](https://github.com/mvdwetering/ynca) de Michel van de Wetering (MIT),
celle de l'intégration Home Assistant `yamaha_ynca`. Intégration non
officielle, sans lien avec Yamaha. Yamaha, AVENTAGE et MusicCast sont des
marques de Yamaha Corporation.
