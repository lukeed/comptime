export type Detail = {
  label: string;
  value: string;
};

type ArticleProps = {
  details: Detail[];
  eyebrow: string;
  title: string;
};

export function Article(props: ArticleProps) {
  return (
    <article class="summary-card">
      <p class="eyebrow">{props.eyebrow}</p>
      <h1>{props.title}</h1>
      <dl>
        {props.details.map((detail) => (
          <div class="detail" key={detail.label}>
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
