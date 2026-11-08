import { expect, mock, test } from 'claude-code/testing'

// Ces tests lisent la ligne en français, avec un fichier de température réglé (le leur est simulé). Le style par
// défaut est `lisse` (images vectorielles) ; la plupart portent sur les autres styles, en texte.
const FR = { language: 'fr', temperatureFile: '/tmp/mac-temperature.txt' } as const
const LISSE = { options: FR } as const
const BARRES = { options: { ...FR, sparkline: 'bars' } } as const
// Comme si la personne tapait /mac : le moteur estampille l'origine et l'affichage, que le test n'a pas à fournir.
const lancerMac = ($: any, args: string) => $.command.run({ command: 'mac', args })

const bandeau = (bodyColumns: number, surface: 'desktop' | 'terminal' = 'desktop') =>
  ({
    plugin: 'mac-sonde',
    component: 'AbovePrompt',
    surface,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

// Couleurs des courbes lisses (une image ne lit pas les couleurs du thème) : vert, orange, rouge.
const VERT = '#3fa34d'
const ORANGE = '#d9922e'
const ROUGE = '#d9534f'

const DATE = 1_800_000_000
const PERIODE_MS = 3000

// 10 cœurs : un processus à `cpu × 10` donne `cpu` % de CPU moyen, une charge de `charge / 10` donne `charge` %.
// RAM : 39,7 Gio utilisés sur 64, soit 62 % (barre ▅, verte).
const releve = (cpu: number, charge: number) => `68719476736
10
{ ${charge / 10} 1.00 1.00 }
total = 7168.00M  used = 5120.00M  free = 2048.00M  (encrypted)
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                             300000.
Pages purgeable:                              100000.
Anonymous pages:                             2000000.
Pages occupied by compressor:                 400000.
 %CPU
 ${cpu * 10}
`

type Mesure = [cpu: number, charge: number, temperature?: number]

// Chaque relevé (le premier au démarrage, puis un toutes les 3 s) rend la mesure suivante ;
// sans température donnée, le fichier du relais est absent. `retenu` : ce que le stockage du mod garde d'avant.
async function apres($: any, on: any, mesures: Mesure[], retenu: Record<string, unknown> = {}) {
  let i = 0
  let courante: Mesure = mesures[0]!
  const horloge = mock.clock(on, { now: (DATE + 1) * 1000 })
  mock.store(on, retenu)
  on('fs.read', () => {
    if (courante[2] === undefined) throw new Error('ENOENT')
    return { value: `${Math.floor(horloge.now() / 1000)} ${courante[2]}` }
  })
  on('command.register', () => ({ value: { command: 'mac' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', () => {
    courante = mesures[Math.min(i++, mesures.length - 1)]!
    return { value: { exitCode: 0, stdout: releve(courante[0], courante[1]), stderr: '' } }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>moteur</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await horloge.advance(PERIODE_MS * (mesures.length - 1))
  return horloge
}

async function ligne($: any, colonnes: number) {
  const ui = await $.ui.mount(bandeau(colonnes))
  const texte = (await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text ?? ''
  await ui.unmount()
  return texte
}

const sansGraphes = (texte: string) => texte.replace(/ [▁-█ ]+(?= ·|$)/g, '')

const TROIS: Mesure[] = [
  [0, 0],
  [50, 25],
  [100, 120],
]

test('chaque graphe suit sa valeur : CPU, RAM, charge', BARRES, async ($, on) => {
  await apres($, on, TROIS)
  expect(await ligne($, 200)).toBe('● Ce Mac · CPU 100 % ▁▅█ · RAM 39,7 Gio ▅▅▅ · charge 120 % ▁▃█ · swap 5,0 Gio')
})

test('la température a son graphe, de 30 °C (▁) à 100 °C (█)', BARRES, async ($, on) => {
  await apres($, on, [
    [0, 0, 30],
    [0, 0, 86],
    [0, 0, 100],
  ])
  expect(await ligne($, 200)).toContain(' · 100 °C ▁▇█ · ')
})

test('un seul relevé : pas encore de graphe', BARRES, async ($, on) => {
  await apres($, on, [[40, 40]])
  expect(await ligne($, 200)).toBe('● Ce Mac · CPU 40 % · RAM 39,7 Gio · charge 40 % · swap 5,0 Gio')
})

test('chaque graphe garde les 10 derniers relevés', BARRES, async ($, on) => {
  await apres($, on, Array.from({ length: 40 }, (_, n): Mesure => [n < 30 ? 100 : 0, 0]))
  expect(await ligne($, 300)).toContain(`CPU 0 % ${'▁'.repeat(10)} · `)
})

test('place comptée : les graphes raccourcissent ensemble, jusqu’à 5 points', BARRES, async ($, on) => {
  await apres($, on, Array.from({ length: 12 }, (): Mesure => [0, 0]))
  const nu = sansGraphes(await ligne($, 300))
  // Trois graphes (CPU, RAM, charge) : une espace et `n` points chacun.
  expect(await ligne($, nu.length + 3 * 11)).toContain(`CPU 0 % ${'▁'.repeat(10)} · `)
  expect(await ligne($, nu.length + 3 * 6)).toContain(`CPU 0 % ${'▁'.repeat(5)} · `)
  expect(await ligne($, nu.length + 3 * 6)).toContain(`charge 0 % ${'▁'.repeat(5)} · `)
})

test('place manquante : la RAM part d’abord, puis la température, puis la charge, le CPU en dernier', BARRES, async ($, on) => {
  await apres($, on, [
    [0, 0, 30],
    [50, 25, 30],
    [100, 120, 30],
  ])
  const nu = sansGraphes(await ligne($, 200))
  expect(nu).toBe('● Ce Mac · CPU 100 % · RAM 39,7 Gio · 30 °C · charge 120 % · swap 5,0 Gio')
  // Une espace et 3 points par graphe.
  expect(await ligne($, nu.length + 16)).toBe(
    '● Ce Mac · CPU 100 % ▁▅█ · RAM 39,7 Gio ▅▅▅ · 30 °C ▁▁▁ · charge 120 % ▁▃█ · swap 5,0 Gio',
  )
  expect(await ligne($, nu.length + 15)).toBe('● Ce Mac · CPU 100 % ▁▅█ · RAM 39,7 Gio · 30 °C ▁▁▁ · charge 120 % ▁▃█ · swap 5,0 Gio')
  expect(await ligne($, nu.length + 11)).toBe('● Ce Mac · CPU 100 % ▁▅█ · RAM 39,7 Gio · 30 °C · charge 120 % ▁▃█ · swap 5,0 Gio')
  expect(await ligne($, nu.length + 7)).toBe('● Ce Mac · CPU 100 % ▁▅█ · RAM 39,7 Gio · 30 °C · charge 120 % · swap 5,0 Gio')
  expect(await ligne($, nu.length + 3)).toBe(nu)
})

test('fenêtre étroite : les graphes partent avant le swap', BARRES, async ($, on) => {
  await apres($, on, TROIS.slice(0, 2))
  // Un graphe de 2 points prend 3 colonnes : avec 2 de libres, plus aucun graphe, mais le swap reste.
  const texte = await ligne($, sansGraphes(await ligne($, 200)).length + 2)
  expect(texte).toContain('swap')
  expect(texte).not.toMatch(/[▁-█]/)
})

// Le desktop dessine le texte en police proportionnelle mais compte la place en cellules à chasse fixe :
// les graphes passent en chasse fixe, et la ligne est coupée en bout plutôt que de passer à la ligne suivante.
test('ligne bornée : jamais de retour à la ligne, graphes en chasse fixe', BARRES, async ($, on) => {
  await apres($, on, TROIS)
  const ui = await $.ui.mount(bandeau(200))
  const dessin = JSON.stringify(await ui.drawn())
  await ui.unmount()
  expect(dessin).toContain('"wrap":"truncate-end"')
  expect(dessin).toContain('"mono":true')
})

// Chaque barre prend la couleur de son niveau : vert sous 70 %, orange dès 70, rouge dès 90 ;
// pour la température, les seuils de chaleur de la pastille : orange dès 85 °C, rouge dès 95.
const couleursDesBarres = (noeud: any): string[] =>
  noeud && typeof noeud === 'object'
    ? noeud.type === 'Text' && /^[▁-█]+$/.test((noeud.children ?? []).join(''))
      ? [...(noeud.children ?? []).join('')].map(() => noeud.props?.color)
      : (noeud.children ?? []).flatMap(couleursDesBarres)
    : []

test('couleurs : chaque barre suit son niveau', BARRES, async ($, on) => {
  await apres($, on, [
    [10, 69, 84],
    [75, 70, 85],
    [95, 120, 95],
  ])
  const ui = await $.ui.mount(bandeau(200))
  const couleurs = couleursDesBarres(await ui.drawn())
  await ui.unmount()
  const montee = ['success', 'warning', 'error']
  // Dans l'ordre de la ligne : CPU, RAM (62 %, vert), température, charge.
  expect(couleurs).toEqual([...montee, 'success', 'success', 'success', ...montee, ...montee])
})

// Trois styles : `barres` (▁▂▃…█, un relevé par caractère), `courbe` (trait en points braille) et `pleine`
// (aire remplie sous la courbe) ; ces deux-là tiennent deux relevés par caractère, sur 4 hauteurs.
// Le style se choisit à l'installation (option `sparkline`) et se change avec `/mac barres|courbe|pleine`.
const QUATRE: Mesure[] = [
  [0, 0],
  [50, 0],
  [100, 0],
  [100, 0],
]

test('style pleine : l’aire sous la courbe est remplie, deux relevés par caractère', { options: { ...FR, sparkline: 'filled' } }, async ($, on) => {
  await apres($, on, QUATRE)
  expect(await ligne($, 200)).toContain(' · CPU 100 % ⣰⣿ · ')
})

test('style courbe : seulement le trait, relié d’un relevé à l’autre', { options: { ...FR, sparkline: 'line' } }, async ($, on) => {
  await apres($, on, QUATRE)
  expect(await ligne($, 200)).toContain(' · CPU 100 % ⣰⠋ · ')
})

test('style barres : un relevé par caractère', BARRES, async ($, on) => {
  await apres($, on, QUATRE)
  expect(await ligne($, 200)).toContain(' · CPU 100 % ▁▅██ · ')
})

test('courbes : 20 relevés tiennent dans 10 caractères', { options: { ...FR, sparkline: 'filled' } }, async ($, on) => {
  await apres($, on, Array.from({ length: 25 }, (): Mesure => [0, 0]))
  expect(await ligne($, 300)).toContain(` · CPU 0 % ${'⣀'.repeat(10)} · `)
})

test('/mac pleine change le style, retient ce choix et passe avant l’option', { options: { ...FR, sparkline: 'bars' } }, async ($, on) => {
  const horloge = await apres($, on, QUATRE)
  const { text } = await lancerMac($, ' Pleine ')
  expect(text).toContain('pleine')
  expect(await ligne($, 200)).toContain(' · CPU 100 % ⣰⣿ · ')
  // Une nouvelle session repart d'un graphe vide mais garde le style : quelques relevés plus tard, toujours en points
  // braille, jamais en barres.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await horloge.advance(PERIODE_MS)
  expect(await ligne($, 200)).toMatch(/ · CPU 100 % [⠀-⣿]+ · /)
})

test('un style retenu dans une autre session vaut au démarrage', BARRES, async ($, on) => {
  await apres($, on, QUATRE, { graphe: 'courbe' })
  expect(await ligne($, 200)).toContain(' · CPU 100 % ⣰⠋ · ')
})

test('/mac avec un mot inconnu : rien ne change, l’aide liste les styles', BARRES, async ($, on) => {
  await apres($, on, QUATRE)
  const { text } = await lancerMac($, 'arc-en-ciel')
  expect(text).toContain('barres')
  expect(text).toContain('courbe')
  expect(text).toContain('pleine')
  expect(await ligne($, 200)).toContain(' · CPU 100 % ▁▅██ · ')
})

// Style `lisse`, le défaut : une vraie courbe continue, dessinée en image vectorielle (Svg) derrière chaque valeur,
// l'aire remplie, la couleur glissant du vert au rouge selon le niveau. Le terminal ne dessine pas d'image :
// il se replie sur la courbe pleine en points.
const svgs = (noeud: any): any[] =>
  noeud && typeof noeud === 'object'
    ? noeud.type === 'Svg'
      ? [noeud.props]
      : (noeud.children ?? []).flatMap(svgs)
    : []

async function dessin($: any, colonnes: number, surface: 'desktop' | 'terminal' = 'desktop') {
  const ui = await $.ui.mount(bandeau(colonnes, surface))
  const arbre = await ui.drawn()
  const texte = (await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text ?? ''
  await ui.unmount()
  return { arbre, json: JSON.stringify(arbre), texte }
}

test('style lisse par défaut : une image vectorielle par graphe, le texte autour', LISSE, async ($, on) => {
  await apres($, on, QUATRE)
  const { arbre, json } = await dessin($, 200)
  const images = svgs(arbre)
  // CPU, RAM et charge (pas de température lue ici), dans l'ordre de la ligne.
  expect(images.map(p => p.alt)).toEqual([
    expect.stringContaining('CPU'),
    expect.stringContaining('RAM'),
    expect.stringContaining('charge'),
  ])
  for (const image of images) {
    expect(image.source).toStartWith('<svg')
    expect(image.source).toContain('<path')
  }
  for (const morceau of ['Ce Mac', ' · CPU 100 %', ' · RAM 39,7 Gio', ' · charge 0 %', ' · swap 5,0 Gio']) {
    expect(json).toContain(morceau)
  }
})

test('lisse : la couleur suit le niveau de chaque relevé', LISSE, async ($, on) => {
  await apres($, on, [
    [10, 0],
    [75, 0],
    [95, 0],
    [95, 0],
  ])
  const [cpu] = svgs((await dessin($, 200)).arbre)
  expect(cpu.source).toContain(VERT)
  expect(cpu.source).toContain(ORANGE)
  expect(cpu.source).toContain(ROUGE)
})

test('lisse dans le terminal : repli sur la courbe pleine en points', LISSE, async ($, on) => {
  await apres($, on, QUATRE)
  const { arbre, texte } = await dessin($, 200, 'terminal')
  expect(svgs(arbre)).toEqual([])
  expect(texte).toContain(' · CPU 100 % ⣰⣿ · ')
})

test('lisse : place comptée, les graphes partent par priorité, le CPU en dernier', LISSE, async ($, on) => {
  await apres($, on, QUATRE)
  const nu = '● Ce Mac · CPU 100 % · RAM 39,7 Gio · charge 0 % · swap 5,0 Gio'
  // Quatre relevés : deux cases par graphe, plus une espace.
  expect(svgs((await dessin($, nu.length + 9)).arbre)).toHaveLength(3)
  expect(svgs((await dessin($, nu.length + 8)).arbre).map(p => p.alt)).toEqual([
    expect.stringContaining('CPU'),
    expect.stringContaining('charge'),
  ])
  expect(svgs((await dessin($, nu.length + 3)).arbre)).toHaveLength(1)
  expect(svgs((await dessin($, nu.length + 2)).arbre)).toHaveLength(0)
})

test('/mac lisse revient au style lisse', BARRES, async ($, on) => {
  await apres($, on, QUATRE)
  const { text } = await lancerMac($, 'lisse')
  expect(text).toContain('lisse')
  expect(svgs((await dessin($, 200)).arbre)).toHaveLength(3)
})

// Fréquence de relevé : lent (10 s), normal (3 s, le défaut) ou rapide (1 s), à l'installation (option `sampling`)
// ou avec `/mac lent|normal|rapide`, retenue comme le style.
async function pointsCpu($: any) {
  return ((await ligne($, 300)).match(/CPU \d+ % ([▁-█]*)/)?.[1] ?? '').length
}

test('fréquence normale par défaut : un relevé toutes les 3 s', BARRES, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]])
  await horloge.advance(9000)
  expect(await pointsCpu($)).toBe(4)
})

test('fréquence rapide à l’installation : un relevé chaque seconde', { options: { ...FR, sparkline: 'bars', sampling: 'fast' } }, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]])
  await horloge.advance(3000)
  expect(await pointsCpu($)).toBe(4)
})

test('/mac lent : un relevé toutes les 10 s, retenu pour la suite', BARRES, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]])
  const { text } = await lancerMac($, 'Lent')
  expect(text).toContain('lent')
  await horloge.advance(20_000)
  expect(await pointsCpu($)).toBe(3)
})

test('/mac rapide puis normal : la fréquence change à chaque fois, sans doubler les relevés', BARRES, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]])
  await lancerMac($, 'rapide')
  await horloge.advance(2000)
  await lancerMac($, 'normal')
  await horloge.advance(3000)
  expect(await pointsCpu($)).toBe(4)
})

test('une fréquence retenue dans une autre session vaut au démarrage', BARRES, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]], { frequence: 'rapide' })
  await horloge.advance(3000)
  expect(await pointsCpu($)).toBe(4)
})

test('/mac avec un mot inconnu : l’aide liste aussi les fréquences', BARRES, async ($, on) => {
  await apres($, on, QUATRE)
  const { text } = await lancerMac($, '30ms')
  for (const mot of ['lisse', 'lent', 'normal', 'rapide']) expect(text).toContain(mot)
})

// En anglais (réglages par défaut) : noms anglais des styles et des fréquences, réponses en anglais ; les noms français
// restent acceptés.
async function ligneEn($: any, colonnes: number) {
  const ui = await $.ui.mount(bandeau(colonnes))
  const texte = (await ui.find({ type: 'Text', text: /This Mac/ }))?.text ?? ''
  await ui.unmount()
  return texte
}

test('by default the sparklines are smooth images, described in English', async ($, on) => {
  await apres($, on, QUATRE)
  const ui = await $.ui.mount(bandeau(200))
  const images = svgs(await ui.drawn())
  await ui.unmount()
  expect(images.map(p => p.alt)).toEqual([
    'CPU: curve of the last 4 readings',
    'RAM: curve of the last 4 readings',
    'load: curve of the last 4 readings',
  ])
})

test('install option sparkline: filled draws the filled curve', { options: { sparkline: 'filled' } }, async ($, on) => {
  await apres($, on, QUATRE)
  expect(await ligneEn($, 200)).toContain(' · CPU 100 % ⣰⣿ · ')
})

test('/mac line switches to the line style and answers in English', async ($, on) => {
  await apres($, on, QUATRE)
  const { text } = await lancerMac($, 'line')
  expect(text).toBe('Sparklines now in line style.')
  expect(await ligneEn($, 200)).toContain(' · CPU 100 % ⣰⠋ · ')
})

test('/mac smooth goes back to the smooth images', { options: { sparkline: 'bars' } }, async ($, on) => {
  await apres($, on, QUATRE)
  expect((await lancerMac($, 'smooth')).text).toBe('Sparklines now in smooth style.')
  const ui = await $.ui.mount(bandeau(200))
  expect(svgs(await ui.drawn())).toHaveLength(3)
  await ui.unmount()
})

test('/mac also takes the French style names', async ($, on) => {
  await apres($, on, QUATRE)
  await lancerMac($, 'pleine')
  expect(await ligneEn($, 200)).toContain(' · CPU 100 % ⣰⣿ · ')
})

test('install option sampling: slow takes a reading every 10 s', { options: { sparkline: 'bars', sampling: 'slow' } }, async ($, on) => {
  const horloge = await apres($, on, [[0, 0]])
  await horloge.advance(20_000)
  expect(((await ligneEn($, 300)).match(/CPU \d+ % ([▁-█]*)/)?.[1] ?? '').length).toBe(3)
})

test('/mac fast answers in English', async ($, on) => {
  await apres($, on, QUATRE)
  expect((await lancerMac($, 'fast')).text).toBe('Sampling fast: one reading every 1 s.')
})

test('/mac with an unknown word: nothing changes, the help lists the English styles and rates', { options: { sparkline: 'bars' } }, async ($, on) => {
  await apres($, on, QUATRE)
  const { text } = await lancerMac($, 'rainbow')
  expect(text).toContain('Unknown setting: "rainbow".')
  for (const mot of ['/mac smooth', '/mac filled', '/mac line', '/mac bars', '/mac slow', '/mac normal', '/mac fast']) {
    expect(text).toContain(mot)
  }
  expect(await ligneEn($, 200)).toContain(' · CPU 100 % ▁▅██ · ')
})
