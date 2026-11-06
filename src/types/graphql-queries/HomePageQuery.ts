
export type HomePageQuery = {
    markdownRemark: {
        frontmatter: {
            title: string;
            heading: string;
            subheading: string;
        }
    };
};