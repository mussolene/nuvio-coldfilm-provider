const fs = require('fs');
const path = require('path');

const root = __dirname;
const source = path.join(root, 'src', 'coldfilm', 'index.js');
const metadata = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'coldfilm', 'scraper.json'), 'utf8')
);
const output = path.join(root, 'dist');
const providers = path.join(output, 'providers');

fs.mkdirSync(providers, { recursive: true });
fs.copyFileSync(source, path.join(providers, 'coldfilm.js'));

const manifest = {
  name: 'ColdFilm для Nuvio',
  version: metadata.version,
  description: 'Провайдер ColdFilm с P2P 1080p и прямыми MP4-потоками',
  scrapers: [
    {
      ...metadata,
      filename: 'providers/coldfilm.js'
    }
  ]
};

fs.writeFileSync(
  path.join(output, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log('Собрано: dist/manifest.json и dist/providers/coldfilm.js');
