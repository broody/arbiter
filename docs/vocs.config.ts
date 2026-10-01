import { defineConfig } from 'vocs/config'

export default defineConfig({
  title: 'Arbiter',
  description: 'Turn-based games played offchain with signed moves and settled on Starknet.',
  socials: [{ icon: 'github', link: 'https://github.com/broody/arbiter' }],
  sidebar: [
    {
      text: 'Introduction',
      items: [
        { text: 'Overview', link: '/' },
        { text: 'How it works', link: '/how-it-works' },
      ],
    },
    {
      text: 'Build a game',
      items: [
        { text: 'Quickstart', link: '/guide/quickstart' },
        { text: 'Write the rules', link: '/guide/rules' },
        { text: 'Mirror the rules in JS', link: '/guide/codec' },
        { text: 'Deploy the channel', link: '/guide/channel' },
        { text: 'Add a proof adapter', link: '/guide/adapter' },
        { text: 'Build the client', link: '/guide/client' },
        { text: 'Add a clock', link: '/guide/clocks', badge: 'optional' },
      ],
    },
    {
      text: 'Concepts',
      items: [
        { text: 'Steps and transcripts', link: '/concepts/protocol' },
        { text: 'The channel and disputes', link: '/concepts/channel' },
        { text: 'Randomness', link: '/concepts/randomness' },
        { text: 'Clocks and the referee', link: '/concepts/clocks' },
        { text: 'Settlement and proofs', link: '/concepts/settlement' },
        { text: 'Signing safety', link: '/concepts/signing-safety' },
        { text: 'Trust model', link: '/concepts/trust' },
      ],
    },
    {
      text: 'Run infrastructure',
      items: [
        { text: 'Keeper', link: '/infra/keeper' },
        { text: 'Prover', link: '/infra/prover' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: '@arbiter/sdk', link: '/reference/sdk' },
        { text: '@arbiter/sdk/proving', link: '/reference/proving' },
        { text: '@arbiter/sdk/store', link: '/reference/store' },
        { text: '@arbiter/sdk/keeper', link: '/reference/keeper-client' },
        { text: 'Keeper HTTP API', link: '/reference/keeper-api' },
        { text: 'Cairo: arbiter', link: '/reference/cairo' },
        { text: 'Cairo: arbiter_dojo, adapter', link: '/reference/dojo' },
        { text: 'Glossary', link: '/reference/glossary' },
      ],
    },
  ],
})
