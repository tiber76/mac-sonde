import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Ces tests lisent la ligne en français, en texte (style barres), avec un fichier de température réglé (le leur est
// simulé) ; le style par défaut, `lisse`, dessine des images (graphe.test.tsx).
const FR = { language: 'fr', temperatureFile: '/tmp/mac-temperature.txt', sparkline: 'bars' } as const
const testFr = (nom: string, corps: TestBody) => test(nom, { options: FR }, corps)

const bandeau = (bodyColumns = 80) =>
  ({
    plugin: 'mac-sonde',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

// 64 Gio, 10 cœurs, pages de 16 Ko : (2 000 000 - 100 000 + 300 000 + 400 000) pages = 39,7 Gio utilisés.
const SORTIE = `68719476736
10
{ 3.44 3.19 3.44 }
total = 7168.00M  used = 5120.00M  free = 2048.00M  (encrypted)
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   294526.
Pages wired down:                             300000.
Pages purgeable:                              100000.
Anonymous pages:                             2000000.
Pages occupied by compressor:                 400000.
 %CPU
 120.5
  60.0
   9.5
`

const DATE = 1_800_000_000

// Ce que `ioreg` rend pour le GPU : une ligne, placée avant la liste des processus.
const avecGpu = (pourcent: number) => SORTIE.replace(' %CPU', `"Device Utilization %"=${pourcent}\n %CPU`)

let dernierReleve = ''
// Les chemins que le mod a lus pendant le test.
let lus: string[] = []

// Ici, l'horloge simulée enchaîne les relevés sans attendre : les graphes se remplissent. Ces tests portent sur les
// chiffres, et lisent donc la ligne sans les graphes (les graphes : graphe.test.tsx).
const sansGraphes = (texte?: string) => texte?.replace(/ [▁-█ ]+(?= ·|$)/g, '')

function demarrage(on: any, relever: () => string | Error, estMasque = false, temperature: string | null = null) {
  const stocke: Record<string, unknown> = {}
  on('clock.now', () => ({ value: (DATE + 1) * 1000 }))
  lus = []
  on('fs.read', (_: unknown, e: any) => {
    lus.push(e.path)
    if (temperature === null) throw new Error('ENOENT')
    return { value: temperature }
  })
  on('command.register', () => ({ value: { command: 'mac' } }))
  // Ce que le moteur propose de lui-même pour le mot en cours : rien, ici.
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: any) => {
    dernierReleve = JSON.stringify(e)
    const sortie = relever()
    if (sortie instanceof Error) throw sortie
    return { value: { exitCode: 0, stdout: sortie, stderr: '' } }
  })
  on('store.get', () => ({ value: estMasque }))
  on('store.set', (_: unknown, e: any) => {
    stocke[e.key] = e.value
    return { value: undefined }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>moteur</Text>
  })
  return stocke
}

// Comme si la personne tapait /mac : le moteur estampille l'origine et l'affichage, que le test n'a pas à fournir.
const lancerMac = ($: any) => $.command.run({ command: 'mac', args: '' })

const demarrer = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

testFr('la ligne donne le CPU moyen des cœurs et la RAM utilisée', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)

  const ui = await $.ui.mount(bandeau())
  const texte = sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)

  expect(texte).toContain('Ce Mac · CPU 19 % · RAM 39,7 Gio')
  expect(texte).toContain('charge 34 % · swap 5,0 Gio')
  await ui.unmount()
})

testFr('en fenêtre étroite, le swap disparaît et la charge reste', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)

  const ui = await $.ui.mount(bandeau(40))

  expect(sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)).toBe(
    '● Ce Mac · CPU 19 % · RAM 39,7 Gio · charge 34 %',
  )
  await ui.unmount()
})

for (const sortie of ['', 'n importe quoi', new Error('échec')]) {
  testFr(`relevé illisible (${sortie}) : aucune mesure inventée`, async ($, on) => {
    demarrage(on, () => sortie)
    await demarrer($)

    const ui = await $.ui.mount(bandeau())

    expect(sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)).toContain('pas de mesure')
    await ui.unmount()
  })
}

for (const [nom, sortie, couleur] of [
  ['tout va bien', SORTIE, 'success'],
  ['CPU à 79 %', SORTIE.replace('120.5', '720.5'), 'warning'],
  ['RAM à 86 %', SORTIE.replace('2000000', '3000000'), 'warning'],
  ['CPU à 91 %', SORTIE.replace('120.5', '840.5'), 'error'],
  ['RAM à 98 %', SORTIE.replace('2000000', '3500000'), 'error'],
] as const) {
  testFr(`pastille : ${nom} donne ${couleur}`, async ($, on) => {
    demarrage(on, () => sortie)
    await demarrer($)

    const ui = await $.ui.mount(bandeau())

    expect(JSON.stringify(await ui.drawn())).toContain(`"color":"${couleur}"`)
    await ui.unmount()
  })
}

testFr('sans mesure : pastille grise, et la ligne est sans cadre', async ($, on) => {
  demarrage(on, () => '')
  await demarrer($)

  const ui = await $.ui.mount(bandeau())
  const dessin = JSON.stringify(await ui.drawn())

  expect(dessin).toContain('"color":"inactive"')
  expect(dessin).not.toContain('borderStyle')
  await ui.unmount()
})

testFr('les lignes des autres mods restent affichées, sous la nôtre', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)

  const ui = await $.ui.mount(bandeau())
  const dessin = JSON.stringify(await ui.drawn())

  expect(dessin.indexOf('Ce Mac')).toBeGreaterThan(-1)
  expect(dessin.indexOf('moteur')).toBeGreaterThan(dessin.indexOf('Ce Mac'))
  await ui.unmount()
})

testFr('/mac masque la ligne et retient ce choix, sans cacher les autres mods', async ($, on) => {
  const stocke = demarrage(on, () => SORTIE)
  await demarrer($)

  const { text } = await lancerMac($)
  expect(text).toContain('masqué')
  expect(Object.values(stocke)).toEqual([true])

  const ui = await $.ui.mount(bandeau())
  const dessin = JSON.stringify(await ui.drawn())

  expect(dessin).not.toContain('Ce Mac')
  expect(dessin).toContain('moteur')
  await ui.unmount()
})

testFr('un masquage enregistré tient au démarrage', async ($, on) => {
  demarrage(on, () => SORTIE, true)
  await demarrer($)

  const ui = await $.ui.mount(bandeau())

  expect(JSON.stringify(await ui.drawn())).not.toContain('Ce Mac')
  await ui.unmount()
})

const ligneMac = async ($: any) => {
  const ui = await $.ui.mount(bandeau())
  const texte = sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)
  const dessin = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return { texte, dessin }
}

testFr('température fraîche : affichée juste après la RAM', async ($, on) => {
  demarrage(on, () => SORTIE, false, `${DATE} 58`)
  await demarrer($)
  expect((await ligneMac($)).texte).toContain('RAM 39,7 Gio · 58 °C · charge 34 % · swap 5,0 Gio')
})

testFr('ligne étroite : la température reste affichée', async ($, on) => {
  demarrage(on, () => SORTIE, false, `${DATE} 58`)
  await demarrer($)
  const ui = await $.ui.mount(bandeau(40))
  expect(sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)).toContain('RAM 39,7 Gio · 58 °C')
  await ui.unmount()
})

for (const [nom, temperature] of [
  ['absente', null],
  ['illisible', 'n importe quoi'],
  ['ancienne', `${DATE - 120} 58`],
] as const) {
  testFr(`température ${nom} : la ligne reste, sans température`, async ($, on) => {
    demarrage(on, () => SORTIE, false, temperature)
    await demarrer($)
    const { texte } = await ligneMac($)
    expect(texte).toContain('CPU 19 % · RAM 39,7 Gio')
    expect(texte).not.toContain('°C')
  })
}

testFr('le relevé demande le GPU à ioreg', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  expect(dernierReleve).toContain('IOAccelerator')
})

testFr('GPU relevé : affiché juste après le CPU', async ($, on) => {
  demarrage(on, () => avecGpu(48))
  await demarrer($)
  expect((await ligneMac($)).texte).toContain('CPU 19 % · GPU 48 % · RAM 39,7 Gio')
})

testFr('ligne étroite : le GPU reste affiché', async ($, on) => {
  demarrage(on, () => avecGpu(48))
  await demarrer($)
  const ui = await $.ui.mount(bandeau(40))
  expect(sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text)).toBe(
    '● Ce Mac · CPU 19 % · GPU 48 % · RAM 39,7 Gio · charge 34 %',
  )
  await ui.unmount()
})

// Largeur de la ligne, sans cadre ni marge : 63 sans GPU ni température, 82 avec les deux.
for (const [nom, sortie, temperature, colonnes, detail] of [
  ['simple, juste assez large', SORTIE, null, 63, true],
  ['simple, une colonne de moins', SORTIE, null, 62, false],
  ['avec GPU et température, juste assez large', avecGpu(48), `${DATE} 58`, 82, true],
  ['avec GPU et température, une colonne de moins', avecGpu(48), `${DATE} 58`, 81, false],
] as const) {
  testFr(`${nom} : swap ${detail ? 'affiché' : 'masqué'}, charge toujours là`, async ($, on) => {
    demarrage(on, () => sortie, false, temperature)
    await demarrer($)
    const ui = await $.ui.mount(bandeau(colonnes))
    const texte = sansGraphes((await ui.find({ type: 'Text', text: /Ce Mac/ }))?.text) ?? ''
    await ui.unmount()
    expect(texte.includes('swap')).toBe(detail)
    expect(texte).toContain('charge 34 %')
  })
}

// La charge (moyenne sur 1 min) est rapportée au nombre de cœurs : 100 % = tous les cœurs pris, au-delà = file d'attente.
for (const [nom, sortie, attendu] of [
  ['10 cœurs, charge 3,44', SORTIE, 'charge 34 %'],
  ['5 cœurs, charge 3,44', SORTIE.replace('\n10\n', '\n5\n'), 'charge 69 %'],
  ['charge au-dessus des cœurs : plus de 100 %', SORTIE.replace('{ 3.44', '{ 25.00'), 'charge 250 %'],
] as const) {
  testFr(`charge en % des cœurs : ${nom}`, async ($, on) => {
    demarrage(on, () => sortie)
    await demarrer($)
    expect((await ligneMac($)).texte).toContain(attendu)
  })
}

testFr('GPU non relevé : la ligne reste, sans GPU', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  const { texte } = await ligneMac($)
  expect(texte).toContain('CPU 19 % · RAM 39,7 Gio')
  expect(texte).not.toContain('GPU')
})

for (const [pourcent, couleur] of [[69, 'success'], [70, 'warning'], [89, 'warning'], [90, 'error']] as const) {
  testFr(`pastille : GPU à ${pourcent} % donne ${couleur}`, async ($, on) => {
    demarrage(on, () => avecGpu(pourcent))
    await demarrer($)
    expect((await ligneMac($)).dessin).toContain(`"color":"${couleur}"`)
  })
}

for (const [degres, couleur] of [[84, 'success'], [85, 'warning'], [94, 'warning'], [95, 'error']] as const) {
  testFr(`pastille : ${degres} °C donne ${couleur}`, async ($, on) => {
    demarrage(on, () => SORTIE, false, `${DATE} ${degres}`)
    await demarrer($)
    expect((await ligneMac($)).dessin).toContain(`"color":"${couleur}"`)
  })
}

// Réglages par défaut : l'anglais, et aucun fichier de température lu.
const ligneThisMac = async ($: any) => {
  const ui = await $.ui.mount(bandeau())
  const texte = sansGraphes((await ui.find({ type: 'Text', text: /This Mac/ }))?.text)
  await ui.unmount()
  return texte
}

test('by default the line is in English, with a dot as decimal separator', { options: { sparkline: 'bars' } }, async ($, on) => {
  demarrage(on, () => avecGpu(48))
  await demarrer($)
  expect(await ligneThisMac($)).toBe('● This Mac · CPU 19 % · GPU 48 % · RAM 39.7 GiB · load 34 % · swap 5.0 GiB')
})

test('by default no temperature file is read', { options: { sparkline: 'bars' } }, async ($, on) => {
  demarrage(on, () => SORTIE, false, `${DATE} 58`)
  await demarrer($)
  expect(lus).toEqual([])
  expect(await ligneThisMac($)).not.toContain('°C')
})

test('a temperature file shows the temperature; ~/ is the home folder', { options: { temperatureFile: '~/sonde.txt', sparkline: 'bars' } }, async ($, on) => {
  demarrage(on, () => SORTIE, false, `${DATE} 58`)
  on('env.get', () => ({ value: '/Users/someone' }))
  await demarrer($)
  expect(lus[0]).toBe('/Users/someone/sonde.txt')
  expect(await ligneThisMac($)).toContain('RAM 39.7 GiB · 58 °C · load 34 %')
})

test('/mac answers in English by default', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  expect(await lancerMac($)).toMatchObject({ text: 'This Mac line hidden. Type /mac to show it again.' })
})

// Autocomplétion des mots après /mac : la zone de saisie demande des suggestions pour le mot en cours de frappe.
const suggerer = ($: any, texte: string) => {
  const start = texte.search(/\S+$/)
  return $.prompt.autocomplete({ text: texte, cursor: texte.length, token: texte.slice(start), start })
}
const textes = (r: any) => r.suggestions.map((s: any) => s.text)

test('after /mac, typing "s" suggests smooth and slow, each with a description', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  const r = await suggerer($, '/mac s')
  expect(textes(r)).toEqual(['smooth', 'slow'])
  for (const s of r.suggestions) expect(s.description?.length).toBeGreaterThan(0)
})

test('after /mac, typing "f" suggests filled and fast', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  expect(textes(await suggerer($, '/mac F'))).toEqual(['filled', 'fast'])
})

test('outside /mac, nothing is suggested', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  expect(textes(await suggerer($, 'make it s'))).toEqual([])
  expect(textes(await suggerer($, '/mac smooth s'))).toEqual([])
  expect(textes(await suggerer($, '/machine s'))).toEqual([])
})

testFr('en français, /mac l propose lisse et lent', async ($, on) => {
  demarrage(on, () => SORTIE)
  await demarrer($)
  expect(textes(await suggerer($, '/mac l'))).toEqual(['lisse', 'lent'])
})
