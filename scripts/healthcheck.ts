const url = process.argv[2];

if (url === undefined) {
  process.exit(2);
}

const healthy = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
  (response) => response.ok,
  () => false,
);

process.exit(healthy ? 0 : 1);
