import { GatsbyNode } from "gatsby";
import { resolve } from "path";
import _ from "lodash";
import { createFilePath } from "gatsby-source-filesystem";


export const createPages: GatsbyNode["createPages"] = async ({
  actions,
  graphql,
}) => {
  const { createPage } = actions;
  const allMarkdown: {
    errors?: any;
    data?: {
      allMarkdownRemark: {
        edges: {
          node: {
            id: any;
            fields: { slug?: string };
            frontmatter: { tags?: any[]; templateKey: string };
          };
        }[];
      };
    };
  } = await graphql(`
    {
      allMarkdownRemark(limit: 1000) {
        edges {
          node {
            id
            fields {
              slug
            }
            frontmatter {
              tags
              templateKey
            }
          }
        }
      }
    }
  `);

  if (allMarkdown.errors) {
    allMarkdown.errors.forEach((e: any) => console.error(e.toString()));
    return Promise.reject(allMarkdown.errors);
  }

  const posts = allMarkdown.data?.allMarkdownRemark?.edges;

  posts?.forEach((edge) => {
    const id = edge.node.id;
    // Only Markdown that names a template is a page (not, say, a README).
    if (edge.node.fields.slug && edge.node.frontmatter.templateKey)
      createPage({
        path: edge.node.fields.slug,
        component: resolve(
          `src/templates/${String(edge.node.frontmatter.templateKey)}.tsx`
        ),
        // additional data can be passed via context
        context: {
          id,
          // An article's related posts are those sharing a tag with it.
          // "Development" is on every post, so it relates nothing.
          relatedTags: (edge.node.frontmatter.tags ?? []).filter(
            (tag: string) => tag !== "Development"
          ),
        },
      });
  });

  // Tag pages:
  let tags: any[] = [];

  // Iterate through each post, putting all found tags into `tags`
  posts?.forEach((edge) => {
    if (_.get(edge, `node.frontmatter.tags`)) {
      tags = tags.concat(edge.node.frontmatter.tags);
    }
  });
  // Eliminate duplicate tags
  tags = _.uniq(tags);

  // Make tag pages
  tags.forEach((tag) => {
    const tagPath = `/tags/${_.kebabCase(tag)}/`;

    createPage({
      path: tagPath,
      component: resolve(`src/templates/tag-page.tsx`),
      context: {
        tag,
      },
    });
  });
};

export const onCreateNode: GatsbyNode["onCreateNode"] = ({
  node,
  actions,
  getNode,
}) => {
  const { createNodeField } = actions;

  if (node.internal.type === `MarkdownRemark`) {
    const value = createFilePath({ node, getNode });
    createNodeField({
      name: `slug`,
      node,
      value,
    });
  }
};

// Declared rather than inferred: a post may credit its cover photo, but none
// has to, and an inferred field disappears from the schema when no file has it.
export const createSchemaCustomization: GatsbyNode["createSchemaCustomization"] = ({ actions }) => {
  actions.createTypes(`
    type MarkdownRemarkFrontmatter {
      topic: String
      illustration: Int
      featuredauthor: String
      featuredlink: String
    }
  `);
};
