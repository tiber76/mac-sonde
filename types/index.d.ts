export type Sortie = string | null
export type Lecture = { ligne: string | null; lueA: number }
/**
 * Les derniers relevés, du plus ancien au plus récent : CPU moyen des cœurs, charge rapportée aux cœurs et part de RAM
 * utilisée (en %), température (°C, `null` quand elle n'était pas lue à ce relevé).
 */
export type Historique = { cpu: number[]; charge: number[]; ram: number[]; temp: (number | null)[] }
/** Le style des graphes : barres, courbe (le trait) ou pleine (l'aire remplie). */
export type Style = 'barres' | 'courbe' | 'pleine'

declare module 'claude-code' {
  interface PluginState {
    'mac-sonde': {
      sortie: Sortie
      temperature: Lecture
      masque: boolean
      historique: Shaped<Historique>
      style: Style
    }
  }
}
