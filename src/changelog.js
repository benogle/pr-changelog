require("babel-polyfill")

let Promise = require("bluebird")
let GithubApi = require('github')
let moment = require('moment')
let paginator = require('./paginator')
let spawnSync = require('child_process').spawnSync;
let {filter} = require('./utils')
let Logger = require('./logger')

let github = new GithubApi({
  version: '3.0.0',
  timeout: 10000,
  protocol: 'https'
});

Promise.promisifyAll(github.repos);
Promise.promisifyAll(github.issues);
Promise.promisifyAll(github.pullRequests);

function authenticate() {
  github.authenticate({
    type: "oauth",
    token: process.env['GITHUB_ACCESS_TOKEN']
  });
}

/*
  Commits
*/

// Get the tag diff locally
function getCommitDiffLocal({owner, repo, base, head, localClone}) {
  let gitDirParams = ['--git-dir', `${localClone}/.git`, '--work-tree', localClone]

  let remote = spawnSync('git', gitDirParams.concat(['config', '--get', 'remote.origin.url'])).stdout.toString()
  if (remote.indexOf(`:${owner}/${repo}.git`) < 0)
    return null

  let commitRegex = /([\da-f]+) ([\d]+) (.+)/
  let commitStrings = spawnSync('git', gitDirParams.concat(['log', '--format="%H %ct %s"', `${base}...${head}`])).stdout.toString().trim().split('\n')
  let commits = commitStrings.map((commitString) => {
    let match = commitString.match(commitRegex)
    let [__, sha, timestamp, summary] = match
    return {sha: sha, summary: summary, date: moment.unix(timestamp)}
  })

  return formatCommits(commits)
}

// This will only return 250 commits when using the API
async function getCommitDiff({owner, repo, base, head, localClone}) {
  let commits
  if (localClone) {
    commits = getCommitDiffLocal({owner, repo, base, head, localClone})
    if (commits) {
      Logger.log('Found', commits.length, 'local commits');
      return commits
    }
    else
      Logger.warn(`Cannot fetch local commit diff, cannot find local copy of ${owner}/${repo}`);
  }

  authenticate()
  let options = {
    user: owner,
    repo: repo,
    base: base,
    head: head
  }

  let compareView = await github.repos.compareCommitsAsync(options)
  Logger.log('Found', compareView.commits.length, 'commits from the GitHub API');
  return formatCommits(compareView.commits)
}

function formatCommits(commits) {
  let commitsResult = []
  let shas = {}
  for (let commit of commits) {
    if (shas[commit.sha]) continue;
    shas[commit.sha] = true
    if (commit.summary)
      commitsResult.push(commit)
    else
      commitsResult.push({
        sha: commit.sha,
        summary: commit.commit.message.split('\n')[0],
        message: commit.commit.message,
        date: moment(commit.commit.committer.date),
        author: commit.commit.author.name
      })
  }
  commitsResult.sort((a, b) => {
    if (a.date.isBefore(b.date))
      return -1
    else if (b.date.isBefore(a.date))
      return 1
    return 0
  })
  return commitsResult
}

function commitsToString(commits) {
  let commitStrings = []
  for (let commit of commits) {
    commitStrings.push(`${commit.sha} ${commit.author} ${commit.summary}`)
  }
  return commitStrings.join('\n')
}

/*
  Pull Requests
*/

async function getPullRequestsBetweenDates({owner, repo, fromDate, toDate}) {
  authenticate()
  let options = {
    user: owner,
    repo: repo,
    state: 'closed',
    sort: 'updated',
    direction: 'desc'
  }

  let mergedPRs = await paginator(options, (options) => {
    return github.pullRequests.getAllAsync(options)
  }, (prs) => {
    prs = filter(prs, (pr) => {
      return !!pr.merged_at
    })
    if (prs.length == 0) return prs

    prs = filter(prs, (pr) => {
      return fromDate.isBefore(moment(pr.merged_at))
    })

    // stop pagination when there are no PRs earlier than this
    if (prs.length == 0) return null

    return prs
  })

  mergedPRs = filter(mergedPRs, (pr) => {
    return toDate.isAfter(moment(pr.merged_at))
  })

  return formatPullRequests(mergedPRs)
}

function filterPullRequestsByCommits(pullRequests, commits) {
  let prRegex = /Merge pull request #(\d+)/
  let filteredPullRequests = []
  let pullRequestsByNumber = {}

  for (let pr of pullRequests) {
    pullRequestsByNumber[pr.number] = pr
  }

  for (let commit of commits) {
    let match = commit.summary.match(prRegex)
    if (!match) continue;

    let prNumber = match[1]
    if (pullRequestsByNumber[prNumber])
      filteredPullRequests.push(pullRequestsByNumber[prNumber])
    else
      Logger.log('No PR found for', prNumber, '; Commit text:', commit.summary);
  }

  return formatPullRequests(filteredPullRequests)
}

function formatPullRequests(pullRequests) {
  let pullRequestsResult = []
  for (let pullRequest of pullRequests) {
    if (pullRequest.htmlURL)
      pullRequestsResult.push(pullRequest)
    else
      pullRequestsResult.push({
        number: pullRequest.number,
        title: pullRequest.title,
        htmlURL: pullRequest.html_url,
        mergedAt: moment(pullRequest.merged_at),
        author: pullRequest.user.login,
        repoName: pullRequest.base.repo.full_name
      })
  }
  pullRequestsResult.sort((a, b) => {
    if (a.mergedAt.isBefore(b.mergedAt))
      return -1
    else if (b.mergedAt.isBefore(a.mergedAt))
      return 1
    return 0
  })
  return pullRequestsResult
}

function pullRequestsToString(pullRequests) {
  let pullRequestStrings = []
  for (let pullRequest of pullRequests) {
    pullRequestStrings.push(`* [${pullRequest.repoName}#${pullRequest.number} - ${pullRequest.title}](${pullRequest.htmlURL}) on ${pullRequest.mergedAt.format('MMMM Do YYYY')}`)
  }
  return pullRequestStrings.join('\n')
}

async function getFormattedPullRequestsBetweenTags({owner, repo, fromTag, toTag, localClone}) {
  Logger.log('Comparing refs', fromTag, toTag, 'on repo', `${owner}/${repo}`);
  if (localClone) Logger.log('Local clone of repo', localClone);

  let commits = await getCommitDiff({
    owner: owner,
    repo: repo,
    base: fromTag,
    head: toTag,
    localClone: localClone
  })
  let firstCommit = commits[0]
  let lastCommit = commits[commits.length - 1]
  let fromDate = firstCommit.date
  let toDate = lastCommit.date

  Logger.log("Fetching PRs between dates", fromDate.toISOString(), toDate.toISOString());
  let pullRequests = await getPullRequestsBetweenDates({
    owner: owner,
    repo: repo,
    fromDate: fromDate,
    toDate: toDate
  })
  Logger.log("Found", pullRequests.length, "merged PRs");

  pullRequests = filterPullRequestsByCommits(pullRequests, commits)
  return pullRequestsToString(pullRequests)
}

module.exports = getFormattedPullRequestsBetweenTags
