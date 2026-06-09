const { src, dest } = require('gulp');

// Copies node and credential icons into dist, preserving their folder structure,
// so n8n can resolve "file:haiflow.svg" next to the compiled node.
function buildIcons() {
	const nodeIcons = src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
	src('credentials/**/*.{png,svg}').pipe(dest('dist/credentials'));
	return nodeIcons;
}

exports['build:icons'] = buildIcons;
exports.default = buildIcons;
