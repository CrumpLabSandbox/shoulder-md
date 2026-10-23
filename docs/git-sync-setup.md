# Setting up a repository for Shoulder sync

Shoulder can keep its folder the same on each of your Macs through a private git repository. Shoulder never asks for a password, token or key: it uses your Mac's own git, so the setup below happens outside the app, once per Mac. Then you paste the repository's address into Shoulder.

You need git on each Mac. Type `git --version` in Terminal; if it is missing, macOS offers to install the command line tools.

There are two ways to let git reach GitHub. Pick one.

- **A. GitHub CLI** (simplest): git uses the GitHub account you sign in with. That account can reach all your repositories.
- **B. A deploy key** (tightest): each Mac gets an SSH key that opens this one repository and nothing else. If a laptop is lost, you remove its key and nothing else is exposed. This is also the shape to use later with a home server instead of GitHub.

## 1. Make the repository (once)

Make it **private** and **empty** (no README, licence or `.gitignore`; Shoulder writes its own). On github.com: New repository, choose Private, leave every "Add" box unticked. Or in Terminal, with GitHub CLI:

```sh
gh repo create <you>/shoulder-library --private
```

Its address is `https://github.com/<you>/shoulder-library.git` (for A) or `git@github.com:<you>/shoulder-library.git` (for B).

## 2A. Sign in with GitHub CLI (each Mac)

```sh
brew install gh
gh auth login
gh auth setup-git
```

`gh auth login` asks a few questions: choose GitHub.com, HTTPS, and sign in with a browser. `gh auth setup-git` tells git to use that sign-in. Check it:

```sh
git ls-remote https://github.com/<you>/shoulder-library.git
```

No output and no error means it works (an empty repository has nothing to list). Use the `https://` address in Shoulder.

## 2B. Add a deploy key (each Mac)

Make a key for this Mac. Press Return at the passphrase prompt for no passphrase (simplest for background sync), or set one and add it to the macOS keychain as shown below.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/shoulder_library -C "shoulder: home mac"
```

Add the public half to the repository with write access. On github.com: the repository's Settings → Deploy keys → Add deploy key, paste the contents of `~/.ssh/shoulder_library.pub`, and tick "Allow write access". Or with GitHub CLI:

```sh
gh repo deploy-key add ~/.ssh/shoulder_library.pub --repo <you>/shoulder-library --allow-write --title "home mac"
```

Tell SSH to use this key for this repository: add these lines to `~/.ssh/config` (create the file if needed). `UseKeychain` only matters if you set a passphrase.

```
Host github-shoulder
  HostName github.com
  User git
  IdentityFile ~/.ssh/shoulder_library
  IdentitiesOnly yes
  AddKeysToAgent yes
  UseKeychain yes
```

If you set a passphrase, store it in the keychain once:

```sh
ssh-add --apple-use-keychain ~/.ssh/shoulder_library
```

Check it:

```sh
git ls-remote git@github-shoulder:<you>/shoulder-library.git
```

No output and no error means it works. Use the `git@github-shoulder:…` address in Shoulder: the `github-shoulder` name is what picks this key.

Repeat 2B on each Mac with its own key and title ("work mac"). GitHub does not allow the same deploy key on two repositories, so a second repository (for the private folder, say) needs its own key and `Host` entry.

## 3. Connect Shoulder

On the first Mac, the one with your documents: File → Set Up Sync… (or Library → Folders → Set up sync…), and paste the address. Tick "Rename the folder to match" if you want the folder named after the repository. Shoulder commits the folder and pushes it.

On each other Mac: choose an empty folder for Shoulder (File → Choose Shared Folder…), then File → Set Up Sync… with the same address. Shoulder downloads the folder. If that Mac's folder already has documents of its own, Shoulder asks first, and can combine the two: where the same file differs, that Mac's version is kept and the other is saved beside it.

## What goes into the repository

Your documents with their full history, reasons and comments, your style guides, and your saved Claude conversations. Your writing samples in `Style/Samples/` stay on each Mac and are not uploaded; copy them yourself if you want them on another Mac. Claude's pending suggestions stay on the Mac that asked for them until you accept them. The private folder (documents with Claude off) is not included unless you set it up with a repository of its own.

## Moving to a home server later

Any git remote works. On each Mac, point the folder at the new address with `git remote set-url origin <new address>` in Terminal, inside the folder; nothing else changes.
