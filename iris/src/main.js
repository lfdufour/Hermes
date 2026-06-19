/**
 * main.js -- Iris app bootstrap.
 *
 * Thin entry point: imports the protocol module and the app controller,
 * then calls initApp. All logic lives in ui/app.js.
 */

import { initApp } from './ui/app.js';
import * as protocol from './protocol/gemma.js';

initApp({ protocol });
