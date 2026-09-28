#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeArtifacts } from './prepare-native-lib.mjs';
prepareNativeArtifacts(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
