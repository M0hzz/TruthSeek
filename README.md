# TruthSeek

A string-diagram discovery board. Give it a JSON file of **nouns**, the **relationships** between them and the **events** that change them. It pins everything to a corkboard, replays the events in order and shows you the ripples you did not write down:

- **Biggest movers**: whose power changed most between two moments.
- **Hidden heavyweights**: nouns with little weight of their own but a lot of power borrowed through their strings.
- **Chokepoints**: nouns that many ripples must pass through.
- **Hidden links**: pairs with no string between them that still move each other through others.
- **Event ripples**: for any event, which nouns it hit directly, which changed as a knock-on effect, and the path the effect took.

## Run it

There is no build step and nothing to install. Open `index.html` in a browser, then drop a JSON file onto the page or press **Sample**.

You can also serve the folder:

```bash
npm start
```

Then open <http://localhost:8080> (add `?sample` to the URL to open the sample board straight away).

## Using the board

| Do this | To |
| --- | --- |
| Click a card or string | Inspect it in the side panel |
| Drag a card | Move it (it stays put afterwards) |
| Shift-drag from one card to another | Tie a new string |
| Double-click a card | Fold its members inside it, or unfold them |
| Drag the board / scroll | Pan / zoom |
| Timeline slider, ← → keys, Space | Step through events, play them |
| Click a ripple path in the panel | Light that path up on the board |
| Type-legend chips | Hide or show a type of noun |
| **Export** | Download the board as JSON, with card positions and engine settings |

Your last board is also kept in the browser's local storage, so you can resume it from the start screen.

## File format

```jsonc
{
  "title": "My board",
  "nouns": [
    {
      "id": "guild",              // unique; made from the name if missing
      "name": "The Guild",
      "type": "faction",          // anything; colors and filters use it
      "weight": 5,                // importance on its own, default 1
      "parent": "city",           // the noun it sits inside (optional)
      "context": "Free text about this noun and its own world.",
      "tags": ["merchants"],
      "exists": false             // optional: absent until an event brings it in
    }
  ],
  "relationships": [
    {
      "from": "mara", "to": "guild",
      "type": "embezzles from",
      "strength": -0.4,           // -1 opposes … +1 supports, default 0.5
      "direction": "one-way"      // power flows from → to; default "two-way"
    }
  ],
  "events": [
    {
      "name": "The Audit",
      "time": 1204,               // a number or a date such as "2024-03-01"
      "description": "…",
      "involves": ["mara"],       // nouns touched without a numeric change
      "effects": [
        { "target": "mara", "power": -1 },                       // change power
        { "target": "mara", "parent": "prison" },                // move inside another noun
        { "target": "guild", "exists": false },                  // disappears (or true: appears)
        { "relationship": ["mara", "guild"], "strength": -0.3 }, // change a string's strength
        { "link": { "from": "mara", "to": "spy", "type": "informs", "strength": 0.6, "direction": "one-way" } },
        { "unlink": ["mara", "guild"] }                          // cut a string
      ]
    }
  ]
}
```

- `relationships` may also be called `relations` or `links`.
- A relationship can be referred to by its `id` or by `[from, to]` (or `[from, to, type]` when two nouns share several strings).
- Events are sorted by `time`. Events without a readable time keep their place after the event before them.
- Problems such as an unknown noun id or a containment loop do not stop the load. They are listed under **Inspect → Load warnings**.
- Fields TruthSeek does not know are kept on export.

`samples/salt-coast.json` is a complete example.

## How power is worked out

For the board after any number of events:

1. **Own power** = `weight` + every `power` change from the events so far.
2. **Containment**: a noun gains `upShare` (default 25%) of each member's power, and passes `downShare` (25%) of its own power to each member.
3. **Ripples**: power travels along strings. The first hop multiplies by the string's strength. Each later hop also multiplies by `decay` (default 0.5), for up to `maxHops` (default 3) hops, along paths that never revisit a noun. Negative strengths carry opposition, so an enemy's strength pushes you down.
4. **Total power** = own + members + everything arriving through strings.

Every number in the side panel can be traced back to the paths that produced it. The values above are adjustable under **Engine** and are saved into the file when you export.

## Project layout

```
index.html          page
css/app.css         styles (light and dark)
js/model.js         read, check, normalize and export board files
js/engine.js        replay events, spread power, find discoveries
js/layout.js        force layout for the cards
js/board.js         SVG corkboard: cards, pins, yarn, pan/zoom, drag
js/app.js           panels, timeline, editing, load/save
samples/            example board (.json, plus a .js copy so it loads from file://)
tests/              engine and model tests
```

## Development

```bash
npm test
```

After editing `samples/salt-coast.json`, regenerate the copy the page loads:

```bash
npm run build:sample
```
