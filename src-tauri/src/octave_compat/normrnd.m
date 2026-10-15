function r = normrnd(mu, sigma, varargin)
  % BridgeDeck fill-in for normrnd (Statistics package).
  if isempty(varargin), sz = size(mu .* sigma); else, sz = [varargin{:}]; if isscalar(sz), sz = [sz sz]; end; end
  r = mu + sigma .* randn(sz);
end
