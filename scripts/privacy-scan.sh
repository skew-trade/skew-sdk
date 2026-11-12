#!/usr/bin/env bash
# The privacy scan: fails when any file of the repository (tracked, or new and not ignored),
# generated code and comments included, any file's path, or the git history (every commit's
# author, committer and message) matches a word of the word list.
#
#   scripts/privacy-scan.sh [WORDS_FILE]
#   scripts/privacy-scan.sh --text [WORDS_FILE] < TEXT   (scans TEXT only)
#
# The word list is kept out of the repository on purpose (a list of what must not be said says
# it). It comes from WORDS_FILE, else $PRIVACY_WORDS_FILE, else $PRIVACY_WORDS (the list itself,
# as CI passes it from a secret), else a local .privacy-words (ignored by git). One extended
# regular expression per line, matched case-insensitively; a line starting with "=" is matched
# case-sensitively; a line starting with "!" is an exact string that is allowed where a word
# would match it; blank lines and lines starting with "#" are skipped. With no list the scan
# fails, unless PRIVACY_SCAN_OPTIONAL=1 (a fork's pull request, which gets no secrets).
set -euo pipefail

text_only=""
if [[ "${1:-}" == --text ]]; then
  text_only=1
  shift
fi
words="${1:-${PRIVACY_WORDS_FILE:-}}"
if [[ -n "${words}" && "${words}" != /* ]]; then
  words="$(pwd)/${words}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
if [[ -n "${text_only}" ]]; then
  cat > "${tmp}/text"
fi

# The repository this script belongs to, wherever it is run from.
cd "$(dirname "${BASH_SOURCE[0]}")"
cd "$(git rev-parse --show-toplevel)"

if [[ -z "${words}" && -n "${PRIVACY_WORDS:-}" ]]; then
  printf '%s\n' "${PRIVACY_WORDS}" > "${tmp}/words"
  words="${tmp}/words"
fi
if [[ -z "${words}" && -f .privacy-words ]]; then
  words=.privacy-words
fi
if [[ -z "${words}" ]]; then
  if [[ "${PRIVACY_SCAN_OPTIONAL:-}" == 1 ]]; then
    echo "privacy scan: no word list (PRIVACY_SCAN_OPTIONAL=1): skipped"
    exit 0
  fi
  echo "privacy scan: no word list: pass a file, or set PRIVACY_WORDS or PRIVACY_WORDS_FILE" >&2
  exit 2
fi

: > "${tmp}/ci"
: > "${tmp}/cs"
mask=() # allowed strings are blanked out before matching (same length, so line numbers hold)
while IFS= read -r line || [[ -n "${line}" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  case "${line}" in
    =*) printf '%s\n' "${line#=}" >> "${tmp}/cs" ;;
    !*)
      allow="${line#!}"
      esc="$(printf '%s' "${allow}" | sed -e 's/[]\/$*.^[]/\\&/g')"
      blank="$(printf '%s' "${allow}" | sed -e 's/./_/g')"
      mask+=(-e "s/${esc}/${blank}/g")
      ;;
    *) printf '%s\n' "${line}" >> "${tmp}/ci" ;;
  esac
done < "${words}"
if [[ ! -s "${tmp}/ci" && ! -s "${tmp}/cs" ]]; then
  echo "privacy scan: the word list is empty" >&2
  exit 2
fi

scan() { # scan FILE LABEL: prints the matching lines as LABEL:LINE: TEXT
  local src="$1" label="$2" masked="${tmp}/masked"
  if ((${#mask[@]})); then sed "${mask[@]}" "${src}" > "${masked}"; else cp "${src}" "${masked}"; fi
  {
    if [[ -s "${tmp}/ci" ]]; then grep -nIiE -f "${tmp}/ci" "${masked}" || true; fi
    if [[ -s "${tmp}/cs" ]]; then grep -nIE -f "${tmp}/cs" "${masked}" || true; fi
  } | sort -t: -k1,1n -u | sed -e "s|^|${label}:|"
}

hits="${tmp}/hits"
: > "${hits}"
n=0
if [[ -n "${text_only}" ]]; then
  scan "${tmp}/text" "(text)" >> "${hits}"
else
  git ls-files -z --cached --others --exclude-standard > "${tmp}/files"
  tr '\0' '\n' < "${tmp}/files" > "${tmp}/paths"
  scan "${tmp}/paths" "(file names)" >> "${hits}"
  while IFS= read -r -d '' f; do
    [[ -f "${f}" ]] || continue
    n=$((n + 1))
    scan "${f}" "${f}" >> "${hits}"
  done < "${tmp}/files"
  # The history: every commit's identities and message (CI checks out the whole history).
  if git rev-parse -q --verify HEAD > /dev/null; then
    git log --all --format='%H %an <%ae> %cn <%ce>%n%B' > "${tmp}/history"
    scan "${tmp}/history" "(git history)" >> "${hits}"
  fi
fi

if [[ -s "${hits}" ]]; then
  echo "privacy scan: $(wc -l < "${hits}" | tr -d ' ') line(s) say what this repository must not:" >&2
  cut -c1-220 "${hits}" >&2
  exit 1
fi
if [[ -n "${text_only}" ]]; then
  echo "privacy scan: the text is clean"
else
  echo "privacy scan: ${n} files and the history, clean"
fi
