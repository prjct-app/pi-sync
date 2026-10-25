if (process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Publish only from main after the reviewed changes have been merged.');
}
