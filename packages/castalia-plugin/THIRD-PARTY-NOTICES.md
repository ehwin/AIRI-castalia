# Third-party notices for `@proj-airi/castalia-plugin`

The AIRI integration code in this package is licensed under the GNU Affero
General Public License, version 3 or any later version.

Parts of this package adapt code from Castalia-Anima, which is licensed under
the MIT License. The MIT License requires that every copy keeps the copyright
notice and the permission notice. This file carries both.

## Code derived from Castalia-Anima

| File in this package | Adapted from |
| --- | --- |
| `src/emotion.ts` | `src/emotion.ts` |
| `src/agent-state.ts` | `src/agentState.ts` |

The adaptation keeps the valence, arousal, and dominance model and the emotion
decay and regression rules. It changes module layout, naming, and the interfaces
that AIRI consumes. It adds no new restriction on the MIT-licensed code.

## MIT License

Copyright (c) 2026 ehwin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
