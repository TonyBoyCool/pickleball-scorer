# Pickleball Cam Scorer

A phone web app that watches a pickleball game through the camera and keeps the score by itself: doubles server 1/2, side outs, and partners switching courts. It shows **who served last** and **the current score**.

## How it works

The app never watches the ball. It only recognizes the setup before each serve and uses the rotation rules to work out what happened in between.

1. **Find the serve setup (doubles).** The receiving team has one player up at the kitchen and one back. The back player is the receiver. The server is the player standing diagonally across, on the matching court at the other end.
2. **Identify the server.** It follows each player from serve to serve. If it loses track of someone, it compares shirt colours, which it learns during the game.
3. **Infer the last rally from the new serve:**
   - same server, now in the other court → the serving team won a point
   - their partner serves → first-server fault, so second server
   - the other team serves → side out
4. **Recover missed serves.** If a serve was missed, it looks for the shortest sequence of rallies that leads to the serve it now sees. When two answers are equally likely, it asks you with one tap.
5. **End of game.** The winning point has no serve after it. If the serving team is at game point and play stops for 35 seconds, the app asks whether they won.

**Singles:** both players stand back, so the server is whoever swings first after both are still. This is less tested than doubles.

## Files

| File | What it is |
|---|---|
| `index.html` | the app screen |
| `app.js` | setup, camera, court corners, prompts, score display |
| `vision.js` | player detection (MoveNet MultiPose via TensorFlow.js), court mapping, serve setup, player identity |
| `engine.js` | scoring rules and working out each rally from the next serve; plain JavaScript you can reuse |
| `sw.js`, `manifest.json`, icons | installs to the home screen; caches the app and detector for courts with weak signal |
| `engine.test.js`, `vision.test.js` | tests: `node engine.test.js && node vision.test.js` |

## Put it online (the camera requires https)

Any static https host works. For example:

- **Azure Static Web Apps or Azure Storage static website:** upload the folder as is.
- **GitHub Pages:** push the folder to a repo, then turn on Pages in the repo settings.
- **On your laptop for testing:** run `npx serve .` and open `http://localhost:3000`. Camera access works on localhost without https.

On the phone, open the URL, tap **Share → Add to Home Screen** (iPhone) or **Install app** (Android), and allow camera access.

## Using it on court

1. **Match setup:** enter team and player names. The player listed first on each team starts in the right court. Pick who serves first and which team is at the baseline you will tap first.
2. Put the phone **high** (fence or tall tripod), behind a baseline or at a corner, so all four players and all four corners of the court are in view. Landscape works best.
3. Tap **Start camera**, then tap the four court corners in order around the court. Check that the overlaid **right/left** labels are correct for players facing the net, and tap **Flip right/left** if not.
4. Play. For the first serve, players should be in their listed starting spots, because that is how the app learns who is who.
5. If the score ever goes wrong, use **Fix the score** to undo or add a rally by hand. The camera picks up again from the fixed score.

**Test before going to the court:** **Test with a video** runs the whole pipeline on a recording from a similar camera angle.

## What has been tested, and what hasn't

- **Scoring engine:** 600 simulated games played rally by rally, with no errors when every serve is seen.
  - If the camera misses about 15% of serves, around 80% of those misses fix themselves at the next serve. The rest need an Undo or a hand fix.
  - Without a way to tell teammates apart, the app would have to ask about 15 times per game. That is why tracking and shirt colours matter.
- **Court geometry and serve setup detection:** checked against 2,500 simulated serve setups with players a few feet off their spots. All were identified correctly.
- **Not yet tested on real footage.** How well the detector finds the far players depends on how high the camera is and how big the far players appear in frame. If far players are missed, raise the camera or choose **Detection: Max detail**.

## Known limits

- **Stacking:** players who stack, or a serving partner standing at the kitchen, can hide the serve setup. The app then waits, and the next normal setup brings it back in sync.
- **Look-alike teammates:** if two teammates wear similar colours and the tracker loses them, you'll get a "Who is serving?" tap now and then.
- **Switching ends:** the app switches ends automatically between games. If you switch mid-game, for example at 6 in game 3, tap **Fix the score → Teams switched ends**. The score is kept.
- **Detector download:** the detector comes from TensorFlow Hub (tfhub.dev, now served via Kaggle) on first load, about 10 MB, and is cached after that.
