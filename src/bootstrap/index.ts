import path from "node:path";
import { ActionsVariable } from "@cdktf/provider-github/lib/actions-variable/index.js";
import { Branch } from "@cdktf/provider-github/lib/branch/index.js";
import { RepositoryFile } from "@cdktf/provider-github/lib/repository-file/index.js";
import { RepositoryPullRequest } from "@cdktf/provider-github/lib/repository-pull-request/index.js";
import type { RepositoryConfig } from "@cdktf/provider-github/lib/repository/index.js";
import { Team } from "@cdktf/provider-github/lib/team/index.js";
import { DataGoogleBillingAccount } from "@cdktf/provider-google/lib/data-google-billing-account/index.js";
import { DataGoogleOrganization } from "@cdktf/provider-google/lib/data-google-organization/index.js";
import { DnsManagedZone } from "@cdktf/provider-google/lib/dns-managed-zone/index.js";
import { DnsRecordSet } from "@cdktf/provider-google/lib/dns-record-set/index.js";
import { StringResource } from "@cdktf/provider-random/lib/string-resource/index.js";
import { Fn, type TerraformProvider } from "cdktf";
import { Construct } from "constructs";
import { GcpProject } from "../gcp-project/index.js";
import { GitHubRepository } from "../github-repository/index.js";

/** Configuration for {@link Bootstrap}. */
export interface BootstrapConfig {
  /** The name of the project being bootstrapped. */
  name: string;

  /** The ID of the GCP organization to provision projects in. Can be fetched by domain using {@link DataGoogleOrganization}. */
  organizationId: string;

  /** The ID of the billing account to provision projects in. Can be fetched by name using {@link DataGoogleBillingAccount}. */
  billingAccountId: string;

  /** The name of the GitHub organization to create repositories in. */
  githubOrg: string;

  /** The domain to serve the application on. */
  domain?: string;

  /** Custom configuration to override {@link GitHubRepository} defaults for app repo. */
  appRepositoryConfig?: Omit<RepositoryConfig, "name">;

  /** Custom configuration to override {@link GitHubRepository} defaults for infra repo. */
  infraRepositoryConfig?: Omit<RepositoryConfig, "name">;

  /** Whether to disable provisioning of GitHub workflow CI/CD scripts. */
  disableGitHubWorkflows?: boolean;

  /** The google-beta provider to use to provision beta configuration of GCP projects. */
  googleBeta: TerraformProvider;
}

/**
 * Bootstrapping for a new project to satisfy curiosity with best practices.
 *
 * This resource creates
 *   - 3 GCP projects, all prefixed with the project name and hyphen
 *     - sysadmin: holds the bootstrapping configuration and shared resources like domains
 *     - dev: development environment for application
 *     - prod: production environment for application
 *   - 2 GitHub repositories
 *     - monorepo: Same name as project, holds all application code
 *     - infra: prefixed with the project name and hyphen, holds infrastructure configuration
 *   - 1 GitHub team
 *     - admins: prefixed with the project name and hyphen, has admin access to all repositories
 */
export class Bootstrap extends Construct {
  /** The sysadmin GCP project. */
  public readonly sysadminProject: GcpProject;

  /** The dev GCP project. */
  public readonly devProject: GcpProject;

  /** The prod GCP project. */
  public readonly prodProject: GcpProject;

  /** The application monorepo. */
  public readonly apprepo: GitHubRepository;

  /** The infrastructure repository. */
  public readonly infraRepo: GitHubRepository;

  /** The github admins team. */
  public readonly githubAdmins: Team;

  constructor(scope: Construct, config: BootstrapConfig) {
    super(scope, config.name);

    this.sysadminProject = new GcpProject(this, {
      projectId: `${config.name}-sysadmin`,
      organizationId: config.organizationId,
      billingAccountId: config.billingAccountId,
      githubInfraRepo: `${config.githubOrg}/${config.name}-infra`,
      githubEnvironment: "prod",
      googleBeta: config.googleBeta,
    });

    this.devProject = new GcpProject(this, {
      projectId: `${config.name}-dev`,
      organizationId: config.organizationId,
      billingAccountId: config.billingAccountId,
      githubInfraRepo: `${config.githubOrg}/${config.name}-infra`,
      githubEnvironment: "dev",
      googleBeta: config.googleBeta,
    });

    this.prodProject = new GcpProject(this, {
      projectId: `${config.name}-prod`,
      organizationId: config.organizationId,
      billingAccountId: config.billingAccountId,
      githubInfraRepo: `${config.githubOrg}/${config.name}-infra`,
      githubEnvironment: "prod",
      googleBeta: config.googleBeta,
    });

    this.githubAdmins = new Team(this, "github-admins", {
      name: `${config.name}-admins`,
      description: `Administrators for the ${config.name} project`,
      privacy: "closed",
    });

    this.apprepo = new GitHubRepository(this, {
      name: config.name,
      adminTeam: this.githubAdmins.id,
      repositoryConfig: config.appRepositoryConfig,
    });

    this.infraRepo = new GitHubRepository(this, {
      name: `${config.name}-infra`,
      adminTeam: this.githubAdmins.id,
      repositoryConfig: config.infraRepositoryConfig,
      prodEnvironmentConfig: {
        reviewers: [
          {
            teams: [Fn.tonumber(this.githubAdmins.id)],
          },
        ],
        dependsOn: [this.githubAdmins],
      },
    });

    if (!config.disableGitHubWorkflows) {
      for (const repo of [
        {
          name: "infra",
          repo: this.infraRepo,
        },
        {
          name: "app",
          repo: this.apprepo,
        },
      ]) {
        new ActionsVariable(this, `gh-var-${repo.name}-gcp-project-id-dev`, {
          repository: repo.repo.repository.name,
          variableName: "GCP_PROJECT_ID_DEV",
          value: this.devProject.project.projectId,
        });

        new ActionsVariable(this, `gh-var-${repo.name}-gcp-project-id-prod`, {
          repository: repo.repo.repository.name,
          variableName: "GCP_PROJECT_ID_PROD",
          value: this.prodProject.project.projectId,
        });

        new ActionsVariable(
          this,
          `gh-var-${repo.name}-gcp-project-number-dev`,
          {
            repository: repo.repo.repository.name,
            variableName: "GCP_PROJECT_NUMBER_DEV",
            value: this.devProject.project.number,
          },
        );

        new ActionsVariable(
          this,
          `gh-var-${repo.name}-gcp-project-number-prod`,
          {
            repository: repo.repo.repository.name,
            variableName: "GCP_PROJECT_NUMBER_PROD",
            value: this.prodProject.project.number,
          },
        );
      }

      const branchSuffix = new StringResource(this, "ci-branch-suffix", {
        length: 16,
        special: false,
        keepers: {
          prWorkflow: Fn.filebase64(
            path.join(__dirname, "templates", "infraWorkflowPr.yaml"),
          ),
          mainWorkflow: Fn.filebase64(
            path.join(__dirname, "templates", "infraWorkflowMain.yaml"),
          ),
        },
      });

      const ciBranch = new Branch(this, "ci-branch", {
        repository: this.infraRepo.repository.name,
        branch: `tf-${branchSuffix.result}`,
      });

      const ciPRWorkflow = new RepositoryFile(this, "infra-ci-pr", {
        repository: this.infraRepo.repository.name,
        branch: ciBranch.branch,
        file: ".github/workflows/pr.yaml",
        content: Fn.file(
          path.join(__dirname, "templates", "infraWorkflowPr.yaml"),
        ),
      });

      const ciMainWorkflow = new RepositoryFile(this, "infra-ci-main", {
        repository: this.infraRepo.repository.name,
        branch: ciBranch.branch,
        file: ".github/workflows/main.yaml",
        content: Fn.file(
          path.join(__dirname, "templates", "infraWorkflowMain.yaml"),
        ),
      });

      new RepositoryPullRequest(this, "infra-ci-pr-apply", {
        baseRepository: this.infraRepo.repository.name,
        baseRef: ciBranch.sourceBranch,
        headRef: ciBranch.branch,
        title: "Update CI workflows",
        body: "This is an automated change to update CI workflows to the latest.",
        dependsOn: [ciPRWorkflow, ciMainWorkflow],
      });
    }

    if (config.domain) {
      const alphaDnsZone = new DnsManagedZone(this, "alpha-dns-zone", {
        project: this.devProject.project.projectId,
        name: `alpha-${config.domain.replaceAll(".", "-")}`,
        dnsName: `alpha.${config.domain}.`,
        dependsOn: [this.devProject.dnsService],
      });

      const prodDnsZone = new DnsManagedZone(this, "prod-dns-zone", {
        project: this.prodProject.project.projectId,
        name: config.domain.replaceAll(".", "-"),
        dnsName: `${config.domain}.`,
        dependsOn: [this.prodProject.dnsService],
      });

      new DnsRecordSet(this, "prod-alpha-ns-delegate", {
        project: this.prodProject.project.projectId,
        managedZone: prodDnsZone.name,
        name: `alpha.${config.domain}.`,
        type: "NS",
        rrdatas: alphaDnsZone.nameServers,
        ttl: 21600,
      });
    }
  }
}
