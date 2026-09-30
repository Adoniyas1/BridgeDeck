export type VendorPin = {
  id: string
  name: string
  version: string
  commit: string
  license: string
  platforms: string
}

export const vendorPins: VendorPin[] = [
  { id: 'rustdesk', name: 'RustDesk', version: '1.4.9', commit: '6c57829', license: 'AGPL-3.0', platforms: 'macOS + Windows' },
  { id: 'syncthing', name: 'Syncthing', version: '2.1.5', commit: '2ca95cf', license: 'MPL-2.0', platforms: 'macOS + Windows' },
  { id: 'localsend', name: 'LocalSend', version: '1.18.2', commit: 'af0416b', license: 'Apache-2.0', platforms: 'macOS + Windows' },
]
