import { RepositoryEnvironmentDeploymentPolicy } from "@cdktf/provider-github/lib/repository-environment-deployment-policy/index.js";
import {
  RepositoryEnvironment,
  type RepositoryEnvironmentConfig,
} from "@cdktf/provider-github/lib/repository-environment/index.js";
import {
  RepositoryRuleset,
  type RepositoryRulesetConfig,
} from "@cdktf/provider-github/lib/repository-ruleset/index.js";
import {
  Repository,
  type RepositoryConfig,
} from "@cdktf/provider-github/lib/repository/index.js";
import { TeamRepository } from "@cdktf/provider-github/lib/team-repository/index.js";
import { Construct } from "constructs";

export interface GitHubRepositoryConfig {
  /** The name of the repository to create within the authenticated organization. */
  name: string;

  /**
   * The name of a team to add with admin permission to the repo. For additional teams,
   * use {@link TeamRepository} directly.
   */
  adminTeam?: string;

  /** Configuration for the repository, will take priority over our defaults. */
  repositoryConfig?: Omit<RepositoryConfig, "name">;

  /** Configuration for the main branch ruleset, will take priority over our defaults. */
  mainRulesetConfig?: Omit<RepositoryRulesetConfig, "repository">;

  /** Configuration for the release branch ruleset, will take priority over our defaults. */
  releaseRulesetConfig?: Omit<RepositoryRulesetConfig, "repository">;

  /** Configuration for the dev environment, will take priority over our defaults. */
  devEnvironmentConfig?: Omit<
    RepositoryEnvironmentConfig,
    "repository" | "environment"
  >;

  /** Configuration for the dev-viewer environment, will take priority over our defaults. */
  devViewerEnvironmentConfig?: Omit<
    RepositoryEnvironmentConfig,
    "repository" | "environment"
  >;

  /** Configuration for the prod environment, will take priority over our defaults. */
  prodEnvironmentConfig?: Omit<
    RepositoryEnvironmentConfig,
    "repository" | "environment"
  >;

  /** Configuration for the prod-viewer environment, will take priority over our defaults. */
  prodViewerEnvironmentConfig?: Omit<
    RepositoryEnvironmentConfig,
    "repository" | "environment"
  >;
}

export class GitHubRepository extends Construct {
  public readonly repository: Repository;

  constructor(scope: Construct, config: GitHubRepositoryConfig) {
    super(scope, config.name);

    this.repository = new Repository(this, "this", {
      name: config.name,

      autoInit: true,
      vulnerabilityAlerts: true,

      allowMergeCommit: false,
      allowSquashMerge: true,
      allowRebaseMerge: false,
      squashMergeCommitTitle: "PR_TITLE",
      squashMergeCommitMessage: "BLANK",

      ...config.repositoryConfig,
    });

    if (config.adminTeam) {
      new TeamRepository(this, "admin-team", {
        repository: this.repository.name,
        teamId: config.adminTeam,
        permission: "admin",
      });
    }

    new RepositoryRuleset(this, "main-ruleset", {
      repository: this.repository.name,
      name: "main",
      enforcement: "active",
      target: "branch",
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      bypassActors: [
        {
          actorType: "RepositoryRole",
          actorId: 5,
          bypassMode: "always",
        },
      ],
      rules: {
        deletion: true,
        requiredLinearHistory: true,
        pullRequest: {
          requiredApprovingReviewCount: 1,
        },
        nonFastForward: true,
      },
      ...config.mainRulesetConfig,
    });

    new RepositoryRuleset(this, "release-ruleset", {
      repository: this.repository.name,
      name: "release",
      enforcement: "active",
      target: "branch",
      conditions: {
        refName: {
          include: ["refs/heads/release/*"],
          exclude: [],
        },
      },
      bypassActors: [
        {
          actorType: "RepositoryRole",
          actorId: 5,
          bypassMode: "always",
        },
      ],
      rules: {
        creation: true,
        update: true,
        deletion: true,
        nonFastForward: true,
      },
      ...config.releaseRulesetConfig,
    });

    new RepositoryEnvironment(this, "env-dev-viewer", {
      repository: this.repository.name,
      environment: "dev-viewer",
      ...config.devViewerEnvironmentConfig,
    });

    const devEnvironment = new RepositoryEnvironment(this, "env-dev", {
      repository: this.repository.name,
      environment: "dev",
      canAdminsBypass: true,
      deploymentBranchPolicy: {
        protectedBranches: false,
        customBranchPolicies: true,
      },
      ...config.devEnvironmentConfig,
    });

    new RepositoryEnvironmentDeploymentPolicy(this, "env-dev-policy", {
      repository: this.repository.name,
      environment: devEnvironment.environment,
      branchPattern: "main",
    });

    const prodViewerEnvironment = new RepositoryEnvironment(
      this,
      "env-prod-viewer",
      {
        repository: this.repository.name,
        environment: "prod-viewer",
        canAdminsBypass: true,
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true,
        },
        ...config.prodViewerEnvironmentConfig,
      },
    );

    new RepositoryEnvironmentDeploymentPolicy(this, "env-prod-viewer-policy", {
      repository: this.repository.name,
      environment: prodViewerEnvironment.environment,
      branchPattern: "release/*",
    });

    const prodEnvironment = new RepositoryEnvironment(this, "env-prod", {
      repository: this.repository.name,
      environment: "prod",
      canAdminsBypass: true,
      deploymentBranchPolicy: {
        protectedBranches: false,
        customBranchPolicies: true,
      },
      ...config.prodEnvironmentConfig,
    });

    new RepositoryEnvironmentDeploymentPolicy(this, "env-prod-policy", {
      repository: this.repository.name,
      environment: prodEnvironment.environment,
      branchPattern: "release/*",
    });
  }
}
