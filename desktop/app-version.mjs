import metadata from '../package.json' with { type: 'json' }

export const displayVersion = metadata.rainbowVersion || metadata.version + '.000'
export const codexClientInfo = { name: 'rainbow_mates', title: metadata.productName, version: metadata.version }
